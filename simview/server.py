import base64
import gzip
import hashlib
import json
import logging
import time
from collections.abc import Sequence
from pathlib import Path

try:
    import orjson
except ImportError:
    orjson = None

from importlib.resources import files

import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from starlette.types import Scope

from simview.utils import find_free_port, read_maybe_gzipped_bytes

logger = logging.getLogger("simview.server")

TEMPLATES = str(files("simview").joinpath("templates"))
STATIC = str(files("simview").joinpath("static"))

# Local-only viewer: CORS is restricted to localhost/127.0.0.1 on any port so a
# browser tab open on another local dev server can't be silently allowed, while
# still letting the bundled UI (served from the same host) talk to the API.
_ALLOWED_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"

# Subdirectories of simview/static that hold vendored, version-pinned third-party
# libraries. These never change for a given release, so they get a long-lived,
# immutable cache header. Everything else under /static (our own JS/CSS/textures)
# is cache-busted via the ?v= query param in index.html instead, so it only needs
# a short revalidation window.
_IMMUTABLE_STATIC_DIRS = ("lib/",)


class BatchNamesRequest(BaseModel):
    names: list[str]


class CacheControlStaticFiles(StaticFiles):
    """StaticFiles that adds a Cache-Control header based on the asset's path."""

    def file_response(
        self, full_path, stat_result, scope: Scope, status_code: int = 200
    ):
        response = super().file_response(full_path, stat_result, scope, status_code)
        # full_path is the absolute filesystem path of the matched file; check it
        # (rather than scope["path"]) since the latter is mount-relative and its
        # exact shape depends on how the StaticFiles app was mounted.
        rel_path = Path(full_path).relative_to(self.directory).as_posix()
        if rel_path.startswith(_IMMUTABLE_STATIC_DIRS):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "public, max-age=60"
        return response


class SimViewServer:
    def __init__(
        self,
        sim_path: str | Path | Sequence[str | Path] | None = None,
        data: dict | None = None,
    ):
        if sim_path is None and data is None:
            raise ValueError("Provide 'sim_path' and/or 'data'")
        if sim_path is None:
            self.sim_paths: list[Path] | None = None
        elif isinstance(sim_path, (list, tuple)):
            self.sim_paths = [Path(p) for p in sim_path]
        else:
            self.sim_paths = [Path(sim_path)]
        # Single-file convenience accessor, used by _load_data when nothing is preloaded.
        self.sim_path = self.sim_paths[0] if self.sim_paths else None
        self._preloaded_data = data
        self.model_data = None

        self.app = FastAPI()
        # Instance-scoped state (self.model_data, self.model_bytes, ...) lives on this
        # object rather than in module-level globals, so multiple SimViewServer
        # instances (e.g. in tests) never share or clobber each other's data. It is
        # also mirrored onto app.state for the FastAPI-idiomatic access pattern.
        self.app.state.server = self

        # Local viewer only: restrict cross-origin requests to localhost/127.0.0.1.
        self.app.add_middleware(
            CORSMiddleware,
            allow_origin_regex=_ALLOWED_ORIGIN_REGEX,
            allow_credentials=True,
            allow_methods=["GET", "POST"],
            allow_headers=["*"],
        )

        # Mount static files and setup templates. StaticFiles adds ETag/Last-Modified
        # headers so unchanged assets (vendored libs, textures) are served from cache;
        # our own JS is cache-busted via the ?v= query param in index.html. The
        # Cache-Control subclass additionally marks vendored libs as immutable.
        self.app.mount(
            "/static", CacheControlStaticFiles(directory=STATIC), name="static"
        )
        self.templates = Jinja2Templates(directory=TEMPLATES)

        # Pre-serialized, gzipped payloads for HTTP serving. The parsed dicts are
        # discarded after compression to avoid holding the simulation twice in memory.
        self.model_bytes = None
        self.states_bytes = None
        self._load_data()

        self.setup_routes()

    def _names_sidecar_path(self) -> Path | None:
        """Where custom batch names get persisted, so they survive a server restart.

        Keyed by a hash of all input paths (not just the first) so that merging the
        same file with different partners doesn't collide on one sidecar."""
        if not self.sim_paths:
            return None
        key = hashlib.sha1(
            "|".join(str(p.resolve()) for p in self.sim_paths).encode()
        ).hexdigest()[:10]
        return (
            self.sim_paths[0].parent
            / f".{self.sim_paths[0].stem}.{key}.batchnames.json"
        )

    def _source_fingerprint(self) -> dict[str, float] | None:
        """mtime of every source file, keyed by resolved path.

        Saved alongside custom batch names so a later load can tell whether the
        source file(s) were regenerated since the names were saved - if so, the
        names no longer necessarily describe the current batches and must not be
        applied."""
        if not self.sim_paths:
            return None
        return {str(p.resolve()): p.stat().st_mtime for p in self.sim_paths}

    def _load_data(self):
        if self._preloaded_data is not None:
            data = self._preloaded_data
            self._preloaded_data = None  # allow it to be garbage-collected
        else:
            logger.info("Loading simulation data from %s...", self.sim_path)
            raw = read_maybe_gzipped_bytes(self.sim_path)
            data = orjson.loads(raw) if orjson else json.loads(raw)

        model_data = data.get("model")
        states_data = data.get("states")

        names_path = self._names_sidecar_path()
        if model_data is not None and names_path and names_path.is_file():
            try:
                payload = json.loads(names_path.read_text())
                # Legacy sidecars are a bare list with no fingerprint; trust them as
                # before. Current sidecars wrap the names with the mtimes of the
                # source file(s) at save time, so a stale sidecar left over from a
                # since-regenerated file can be detected and ignored.
                if isinstance(payload, list):
                    saved_names, saved_fingerprint = payload, None
                else:
                    saved_names = payload.get("names")
                    saved_fingerprint = payload.get("source_mtime")

                sim_batches = int(model_data.get("simBatches", 1))
                stale = (
                    saved_fingerprint is not None
                    and saved_fingerprint != self._source_fingerprint()
                )
                if stale:
                    logger.info(
                        "Ignoring batch names in %s: source file(s) changed since "
                        "they were saved.",
                        names_path,
                    )
                elif isinstance(saved_names, list) and len(saved_names) == sim_batches:
                    model_data["batchNames"] = saved_names
            except (OSError, ValueError, json.JSONDecodeError) as e:
                logger.warning("Failed to load batch names from %s: %s", names_path, e)

        self.blobs = []

        def extract_blobs(obj):
            if isinstance(obj, dict):
                for k, v in obj.items():
                    if isinstance(v, str) and v.startswith("__b64__"):
                        blob_id = len(self.blobs)
                        self.blobs.append(base64.b64decode(v[7:]))
                        obj[k] = f"/blob/{blob_id}"
                    else:
                        extract_blobs(v)
            elif isinstance(obj, list):
                for i, v in enumerate(obj):
                    if isinstance(v, str) and v.startswith("__b64__"):
                        blob_id = len(self.blobs)
                        self.blobs.append(base64.b64decode(v[7:]))
                        obj[i] = f"/blob/{blob_id}"
                    else:
                        extract_blobs(v)

        self.model_data = model_data

        if self.model_data is not None:
            extract_blobs(self.model_data)

        # Pre-serialize and pre-compress once so HTTP endpoints never do work per request.
        # compresslevel=1 is fastest (still typically 5-10x smaller for JSON). model_data
        # itself is kept around (it's small, unlike states_data) so /batch-names can
        # patch and re-serialize it without re-reading the source file.
        self._dumps = orjson.dumps if orjson else (lambda o: json.dumps(o).encode())
        if model_data is not None:
            self.model_bytes = gzip.compress(self._dumps(model_data), compresslevel=1)
        if states_data is not None:
            self.states_bytes = gzip.compress(self._dumps(states_data), compresslevel=1)

        logger.info("Simulation data loaded successfully.")

    def setup_routes(self):
        @self.app.get("/")
        async def index(request: Request):
            return self.templates.TemplateResponse(
                request=request,
                name="index.html",
                context={"request": request, "t": int(time.time())},
            )

        _gzip_headers = {"Content-Encoding": "gzip"}

        @self.app.get("/model")
        async def get_model():
            logger.debug("HTTP: Client requested /model")
            if self.model_bytes is not None:
                return Response(
                    content=self.model_bytes,
                    media_type="application/json",
                    headers=_gzip_headers,
                )
            return Response(
                content=b'{"message":"Model data not available"}',
                media_type="application/json",
                status_code=404,
            )

        @self.app.get("/states")
        async def get_states():
            logger.debug("HTTP: Client requested /states")
            if self.states_bytes is not None:
                return Response(
                    content=self.states_bytes,
                    media_type="application/json",
                    headers=_gzip_headers,
                )
            return Response(
                content=b'{"message":"States data not available"}',
                media_type="application/json",
                status_code=404,
            )

        @self.app.get("/blob/{blob_id}")
        async def get_blob(blob_id: int):
            if 0 <= blob_id < len(self.blobs):
                return Response(
                    content=self.blobs[blob_id], media_type="application/octet-stream"
                )
            return Response(status_code=404)

        @self.app.post("/batch-names")
        async def set_batch_names(body: BatchNamesRequest):
            if self.model_data is None:
                return Response(
                    content=b'{"message":"Model data not available"}',
                    media_type="application/json",
                    status_code=404,
                )
            names = body.names
            sim_batches = int(self.model_data.get("simBatches", 1))
            if len(names) != sim_batches:
                return Response(
                    content=b'{"message":"Expected {\\"names\\": [str, ...]} matching simBatches"}',
                    media_type="application/json",
                    status_code=400,
                )

            self.model_data["batchNames"] = names
            self.model_bytes = gzip.compress(
                self._dumps(self.model_data), compresslevel=1
            )

            names_path = self._names_sidecar_path()
            if names_path:
                try:
                    payload = {
                        "names": names,
                        "source_mtime": self._source_fingerprint(),
                    }
                    names_path.write_text(json.dumps(payload))
                except OSError as e:
                    logger.warning(
                        "Failed to persist batch names to %s: %s", names_path, e
                    )

            return {"ok": True}

    def run(
        self,
        debug: bool = False,
        host: str = "127.0.0.1",
        port: int = 5420,
        open_browser: bool = False,
    ):
        logger.info("SimView server running on http://%s:%s", host, port)
        if open_browser:
            import threading
            import webbrowser

            # uvicorn.run() below blocks until the server stops, so the browser is
            # opened from a background timer instead of a startup hook (FastAPI's
            # on_event/lifespan hooks are more ceremony than this one-shot needs).
            # The short delay gives uvicorn a head start on binding the socket.
            bind_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
            threading.Timer(
                0.5, webbrowser.open, args=(f"http://{bind_host}:{port}",)
            ).start()

        # uvloop/httptools are faster than the stdlib fallbacks but aren't available
        # everywhere (uvloop doesn't support Windows). Use them opportunistically and
        # fall back to uvicorn's "auto" detection rather than crashing at startup.
        try:
            import uvloop  # noqa: F401

            loop = "uvloop"
        except ImportError:
            loop = "auto"
        try:
            import httptools  # noqa: F401

            http = "httptools"
        except ImportError:
            http = "auto"
        uvicorn.run(
            self.app,
            host=host,
            port=port,
            log_level="debug" if debug else "info",
            loop=loop,
            http=http,
        )

    @staticmethod
    def start(
        sim_path: str | Path | Sequence[str | Path],
        host: str = "127.0.0.1",
        preferred_port: int = 5420,
        open_browser: bool = False,
    ):
        paths = (
            [Path(p) for p in sim_path]
            if isinstance(sim_path, (list, tuple))
            else [Path(sim_path)]
        )
        for p in paths:
            if not p.is_file():
                raise FileNotFoundError(f"Simulation file '{p}' does not exist.")

        if len(paths) > 1:
            from simview.merge import merge_simulation_files

            server = SimViewServer(data=merge_simulation_files(paths), sim_path=paths)
        else:
            server = SimViewServer(sim_path=paths[0])
        port = find_free_port(host, preferred_port)
        if port != preferred_port:
            logger.warning(
                "Preferred port %s is not available. Using port %s instead.",
                preferred_port,
                port,
            )
        server.run(host=host, port=port, open_browser=open_browser)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run the SimView server.")
    parser.add_argument(
        "--sim_path", type=str, required=True, help="Path to the simulation JSON file."
    )
    args = parser.parse_args()
    SimViewServer.start(args.sim_path)
