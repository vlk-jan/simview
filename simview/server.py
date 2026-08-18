import asyncio
import base64
import copy
import gzip
import hashlib
import json
import logging
import secrets
import time
from collections import deque
from collections.abc import Sequence
from contextlib import asynccontextmanager
from pathlib import Path

try:
    import orjson
except ImportError:
    orjson = None

try:
    import numpy as np
except ImportError:
    np = None

from importlib.resources import files

import uvicorn
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from starlette.types import Scope

from simview.columnar import columnarize_states, is_columnar
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

# Live mode: how many recent frames to keep for replaying to viewers that
# connect mid-run. Bounded so an open-ended run (RL training, a long-running
# sim) doesn't grow the server's memory without limit; a viewer connecting
# after the cap is reached sees the most recent window rather than the whole
# run. The full run is still whatever the producer keeps in scene.states.
_LIVE_FRAME_BUFFER_MAXLEN = 10_000
# How many frames to put in one catch-up WebSocket message. The client feeds
# every message through the same processStatesChunk path (SimView.js), so
# slicing the replay costs nothing there and avoids serializing (and buffering
# in memory, twice) one multi-megabyte string for a long run.
_CATCHUP_CHUNK_SIZE = 500


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
        # self.directory is set from the `directory=` kwarg we always pass to
        # StaticFiles.__init__ (see the mount() call below), so it's never None
        # here even though the base class types it as Optional for callers that
        # use `packages=` instead.
        assert self.directory is not None
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
        live: bool = False,
        frame_buffer_size: int = _LIVE_FRAME_BUFFER_MAXLEN,
    ):
        if sim_path is None and data is None:
            raise ValueError("Provide 'sim_path' and/or 'data'")
        # Live streaming mode (see simview.live.LiveViewer): /states reports
        # {"live": true} instead of serving a (possibly empty) states array,
        # and a /ws/states endpoint is registered to push frames as they're
        # produced. self.ws_clients is only ever mutated on self.loop (set by
        # LiveViewer once the server thread's event loop is running) so
        # push_state's broadcast, running on the caller's thread, never races
        # a client connecting/disconnecting on the server thread.
        self.live = live
        self.loop = None
        self.ws_clients: set[WebSocket] = set()
        # Recent frames (live mode only), replayed as the catch-up messages to
        # a client connecting after the run started. Mirrors scene.states,
        # which LiveViewer.push_state also appends to via scene.add_state --
        # kept as a separate buffer here rather than reaching into the scene so
        # SimViewServer doesn't need a reference to it. Bounded: on a run
        # longer than the cap the oldest frames are forgotten, so a late viewer
        # replays the most recent window instead of the entire history.
        self.frame_buffer: deque[dict] = deque(maxlen=frame_buffer_size)
        if sim_path is None:
            self.sim_paths: list[Path] | None = None
        elif isinstance(sim_path, (str, Path)):
            self.sim_paths = [Path(sim_path)]
        else:
            self.sim_paths = [Path(p) for p in sim_path]
        # Single-file convenience accessor, used by _load_data when nothing is preloaded.
        self.sim_path = self.sim_paths[0] if self.sim_paths else None
        self._preloaded_data = data
        self.model_data = None

        @asynccontextmanager
        async def lifespan(app: FastAPI):
            # Captured here (rather than e.g. in run()) because this runs on
            # the server thread's event loop once uvicorn starts serving --
            # LiveViewer needs this exact loop object to bridge push_state
            # (caller's thread) into broadcast_frame via
            # asyncio.run_coroutine_threadsafe.
            self.loop = asyncio.get_running_loop()
            yield

        self.app = FastAPI(lifespan=lifespan)
        # Instance-scoped state (self.model_data, self.model_bytes, ...) lives on this
        # object rather than in module-level globals, so multiple SimViewServer
        # instances (e.g. in tests) never share or clobber each other's data. It is
        # also mirrored onto app.state for the FastAPI-idiomatic access pattern.
        self.app.state.server = self

        # Local viewer only: restrict cross-origin requests to localhost/127.0.0.1.
        # No allow_credentials: the API doesn't use cookies or auth headers, and
        # combining credentials with an any-localhost-port origin regex would let
        # any other local dev server read a scene's data with the user's session.
        self.app.add_middleware(
            CORSMiddleware,
            allow_origin_regex=_ALLOWED_ORIGIN_REGEX,
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
        data = self._preloaded_data
        preloaded = data is not None
        if preloaded:
            self._preloaded_data = None  # allow it to be garbage-collected
        else:
            # __init__ requires sim_path and/or data; if we get here,
            # _preloaded_data was None, so sim_path (hence self.sim_path) was
            # provided and is guaranteed non-None.
            assert self.sim_path is not None
            logger.info("Loading simulation data from %s...", self.sim_path)
            raw = read_maybe_gzipped_bytes(self.sim_path)
            data = orjson.loads(raw) if orjson else json.loads(raw)

        model_data = data.get("model")
        states_data = data.get("states")

        # In-memory callers (SimulationScene.show, LiveViewer, SimViewLauncher)
        # hand over dicts that still share structure with the live scene --
        # SimViewBody.to_json() returns `shape` by reference, for example.
        # extract_blobs below rewrites `__b64__` strings in place, which would
        # otherwise corrupt the caller's scene (a later scene.save() would
        # write dead "/blob/..." URLs, and a second show() would serve stale
        # blob references). Deep-copying just the model is cheap: the big
        # payloads are immutable blob strings, which deepcopy shares rather
        # than duplicating. `states` is never mutated, so it isn't copied.
        if preloaded and model_data is not None:
            model_data = copy.deepcopy(model_data)

        names_path = self._names_sidecar_path()
        if model_data is not None and names_path and names_path.is_file():
            try:
                payload = json.loads(names_path.read_text())
                # Sidecars wrap the names with the mtimes of the source file(s)
                # at save time, so a stale sidecar left over from a
                # since-regenerated file can be detected and ignored.
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
        # Random per-load token folded into every blob URL so it's safe to cache
        # them forever: a later server restart serving a different scene on the
        # same port gets a different token, so it can never collide with a
        # stale cached response for blob id N from a previous load.
        self._blob_token = secrets.token_hex(4)

        def extract_blobs(obj):
            if isinstance(obj, dict):
                for k, v in obj.items():
                    if isinstance(v, str) and v.startswith("__b64__"):
                        blob_id = len(self.blobs)
                        self.blobs.append(base64.b64decode(v[7:]))
                        obj[k] = f"/blob/{self._blob_token}/{blob_id}"
                    else:
                        extract_blobs(v)
            elif isinstance(obj, list):
                for i, v in enumerate(obj):
                    if isinstance(v, str) and v.startswith("__b64__"):
                        blob_id = len(self.blobs)
                        self.blobs.append(base64.b64decode(v[7:]))
                        obj[i] = f"/blob/{self._blob_token}/{blob_id}"
                    else:
                        extract_blobs(v)

        self.model_data = model_data

        if self.model_data is not None:
            extract_blobs(self.model_data)

        def register_blob(raw: bytes) -> str:
            blob_id = len(self.blobs)
            self.blobs.append(raw)
            return f"/blob/{self._blob_token}/{blob_id}"

        if is_columnar(states_data):
            # The file is already columnar (SimulationScene.save's default) --
            # no repack at all, just rewrite its inline __b64__ blobs into
            # /blob/ URLs, which is exactly what extract_blobs does. This is
            # the cheap path the on-disk format exists for.
            extract_blobs(states_data)
        elif isinstance(states_data, list) and states_data:
            # Legacy per-frame file: repack into whole-trajectory columnar
            # blobs so the viewer parses one lightweight JSON index plus raw
            # binary instead of thousands of tiny per-frame objects/base64
            # strings. Falls back to serving `states_data` exactly as before if
            # it isn't strictly consistent across frames (see columnar.py).
            columnar = columnarize_states(states_data, model_data, register_blob)
            if columnar is not None:
                states_data = columnar
        # Discard the raw per-frame states list now that everything needed
        # from it (columnar or not) has been extracted -- it can be large
        # (the dominant memory user for a long simulation).
        del data

        # Pre-serialize and pre-compress once so HTTP endpoints never do work per request.
        # compresslevel=1 is fastest (still typically 5-10x smaller for JSON). model_data
        # itself is kept around (it's small, unlike states_data) so /batch-names can
        # patch and re-serialize it without re-reading the source file.
        self._dumps = orjson.dumps if orjson else (lambda o: json.dumps(o).encode())
        if model_data is not None:
            self.model_bytes = gzip.compress(self._dumps(model_data), compresslevel=1)
        if self.live:
            # Live mode: frames arrive over /ws/states instead, so /states just
            # tells the client to open the socket (see loadData in SimView.js).
            self.states_bytes = gzip.compress(
                self._dumps({"live": True}), compresslevel=1
            )
        elif states_data is not None:
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

        @self.app.get("/blob/{token}/{blob_id}")
        async def get_blob(token: str, blob_id: int):
            if token != self._blob_token or not (0 <= blob_id < len(self.blobs)):
                return Response(status_code=404)
            return Response(
                content=self.blobs[blob_id],
                media_type="application/octet-stream",
                headers={"Cache-Control": "public, max-age=31536000, immutable"},
            )

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

        if self.live:
            # Only registered in live mode: LiveViewer.push_state broadcasts
            # each new frame to every connected socket (see broadcast_frame).
            # Frames buffered before this client connected are replayed first,
            # so a viewer opened mid-run still sees the recent timeline.
            @self.app.websocket("/ws/states")
            async def ws_states(websocket: WebSocket):
                await websocket.accept()
                try:
                    await self._send_catchup(websocket)
                    while True:
                        # This endpoint is push-only; block here until the
                        # client disconnects (or the connection otherwise dies)
                        # so the `finally` below can discard it.
                        await websocket.receive_text()
                except WebSocketDisconnect:
                    pass
                finally:
                    self.ws_clients.discard(websocket)

    async def _send_catchup(self, websocket: WebSocket) -> None:
        """Replay the buffered history to a just-connected client, in slices.

        Registers the socket for live broadcasts only once the replay has
        caught up, so a frame pushed mid-replay can't overtake the history it
        belongs after. Because this runs on the server's event loop -- the same
        loop broadcast_frame runs on -- no frame can be appended between the
        final "nothing left to replay" check and the registration below.

        (Frames pushed during the replay are picked up by the outer loop. A run
        that overflows the whole frame buffer *while* one client is catching up
        could skip a few frames in that client's replay; at that rate the
        buffer's own bound is already dropping history anyway.)
        """
        replayed = 0
        while True:
            pending = list(self.frame_buffer)[replayed:]
            if not pending:
                self.ws_clients.add(websocket)
                return
            for start in range(0, len(pending), _CATCHUP_CHUNK_SIZE):
                chunk = pending[start : start + _CATCHUP_CHUNK_SIZE]
                await websocket.send_text(json.dumps({"states": chunk}))
            replayed += len(pending)

    async def broadcast_frame(self, frame: dict) -> None:
        """Send one newly-pushed frame to every connected /ws/states client.

        Must run on self.loop (the server thread's event loop) -- LiveViewer
        schedules this via asyncio.run_coroutine_threadsafe rather than
        calling it directly from the caller's thread. A dead/broken socket is
        dropped rather than allowed to raise, since one slow/gone client must
        never break the broadcast (or the caller's push_state) for the rest.
        """
        if not self.ws_clients:
            return
        message = json.dumps({"states": [frame]})
        dead = []
        for client in self.ws_clients:
            try:
                await client.send_text(message)
            except Exception:
                dead.append(client)
        for client in dead:
            self.ws_clients.discard(client)

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
            access_log=debug,
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
            [Path(sim_path)]
            if isinstance(sim_path, (str, Path))
            else [Path(p) for p in sim_path]
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
