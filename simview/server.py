import base64
import gzip
import hashlib
import json
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
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from simview.utils import find_free_port

TEMPLATES = str(files("simview").joinpath("templates"))
STATIC = str(files("simview").joinpath("static"))


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

        # Mount static files and setup templates. StaticFiles adds ETag/Last-Modified
        # headers so unchanged assets (vendored libs, textures) are served from cache;
        # our own JS is cache-busted via the ?v= query param in index.html.
        self.app.mount("/static", StaticFiles(directory=STATIC), name="static")
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

    def _load_data(self):
        if self._preloaded_data is not None:
            data = self._preloaded_data
            self._preloaded_data = None  # allow it to be garbage-collected
        else:
            print(f"Loading simulation data from {self.sim_path}...")
            if orjson:
                with open(self.sim_path, "rb") as f:
                    data = orjson.loads(f.read())
            else:
                with open(self.sim_path, "r") as f:
                    data = json.load(f)

        model_data = data.get("model")
        states_data = data.get("states")

        names_path = self._names_sidecar_path()
        if model_data is not None and names_path and names_path.is_file():
            try:
                saved_names = json.loads(names_path.read_text())
                sim_batches = int(model_data.get("simBatches", 1))
                if isinstance(saved_names, list) and len(saved_names) == sim_batches:
                    model_data["batchNames"] = saved_names
            except (OSError, ValueError, json.JSONDecodeError) as e:
                print(f"Warning: failed to load batch names from {names_path}: {e}")

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

        print("Simulation data loaded successfully.")

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
            print("HTTP: Client requested /model")
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
            print("HTTP: Client requested /states")
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
        async def set_batch_names(request: Request):
            if self.model_data is None:
                return Response(
                    content=b'{"message":"Model data not available"}',
                    media_type="application/json",
                    status_code=404,
                )
            body = await request.json()
            names = body.get("names")
            sim_batches = int(self.model_data.get("simBatches", 1))
            if (
                not isinstance(names, list)
                or len(names) != sim_batches
                or not all(isinstance(n, str) for n in names)
            ):
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
                    names_path.write_text(json.dumps(names))
                except OSError as e:
                    print(
                        f"Warning: failed to persist batch names to {names_path}: {e}"
                    )

            return {"ok": True}

    def run(self, debug: bool = False, host: str = "127.0.0.1", port: int = 5420):
        print(f"SimView server running on http://{host}:{port}")
        uvicorn.run(
            self.app,
            host=host,
            port=port,
            log_level="debug" if debug else "info",
            loop="uvloop",
            http="httptools",
        )

    @staticmethod
    def start(
        sim_path: str | Path | Sequence[str | Path],
        host: str = "127.0.0.1",
        preferred_port: int = 5420,
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
            print(
                f"Preferred port {preferred_port} is not available. Using port {port} instead."
            )
        server.run(host=host, port=port)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run the SimView server.")
    parser.add_argument(
        "--sim_path", type=str, required=True, help="Path to the simulation JSON file."
    )
    args = parser.parse_args()
    SimViewServer.start(args.sim_path)
