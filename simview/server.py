import gzip
import json
import time
from pathlib import Path

try:
    import orjson
except ImportError:
    orjson = None

from importlib.resources import files

import socketio
import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from simview.utils import find_free_port

TEMPLATES = str(files("simview").joinpath("templates"))
STATIC = str(files("simview").joinpath("static"))


class OrjsonWrapper:
    """Wrapper to make orjson compatible with socketio's json argument (expects dumps to return str)."""

    @staticmethod
    def dumps(obj, **kwargs):
        if orjson:
            return orjson.dumps(obj).decode("utf-8")
        return json.dumps(obj, **kwargs)

    @staticmethod
    def loads(s, **kwargs):
        if orjson:
            return orjson.loads(s)
        return json.loads(s, **kwargs)


class SimViewServer:
    def __init__(self, sim_path: str | Path):
        self.sim_path = Path(sim_path)

        # Initialize Socket.IO AsyncServer
        self.sio = socketio.AsyncServer(
            async_mode="asgi",
            cors_allowed_origins="*",
            # Buffer size for smaller real-time updates (kept generous at 100MB)
            max_http_buffer_size=100 * 1024 * 1024,
            json=OrjsonWrapper,
        )

        self.app = FastAPI()

        # Mount static files and setup templates. StaticFiles adds ETag/Last-Modified
        # headers so unchanged assets (vendored libs, textures) are served from cache;
        # our own JS is cache-busted via the ?v= query param in index.html.
        self.app.mount("/static", StaticFiles(directory=STATIC), name="static")
        self.templates = Jinja2Templates(directory=TEMPLATES)

        # Combine SIO and FastAPI into one ASGI application
        self.socket_app = socketio.ASGIApp(self.sio, self.app)

        # Pre-serialized, gzipped payloads for HTTP serving. The parsed dicts are
        # discarded after compression to avoid holding the simulation twice in memory.
        self.model_bytes = None
        self.states_bytes = None
        self._load_data()

        self.setup_routes()
        self.setup_socket_handlers()

    def _load_data(self):
        print(f"Loading simulation data from {self.sim_path}...")
        if orjson:
            with open(self.sim_path, "rb") as f:
                data = orjson.loads(f.read())
        else:
            with open(self.sim_path, "r") as f:
                data = json.load(f)

        model_data = data.get("model")
        states_data = data.get("states")

        # Pre-serialize and pre-compress once so HTTP endpoints never do work per request.
        # compresslevel=1 is fastest (still typically 5-10x smaller for JSON).
        _dumps = orjson.dumps if orjson else (lambda o: json.dumps(o).encode())
        if model_data is not None:
            self.model_bytes = gzip.compress(_dumps(model_data), compresslevel=1)
        if states_data is not None:
            self.states_bytes = gzip.compress(_dumps(states_data), compresslevel=1)

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

    def setup_socket_handlers(self):
        @self.sio.on("connect")
        async def handle_connect(sid, environ):
            print(f"Client connected: {sid}")

        @self.sio.on("disconnect")
        async def handle_disconnect(sid):
            print(f"Client disconnected: {sid}")

    def run(self, debug: bool = False, host: str = "127.0.0.1", port: int = 5420):
        print(f"SimView server running on http://{host}:{port}")
        uvicorn.run(
            self.socket_app,
            host=host,
            port=port,
            log_level="debug" if debug else "info",
            loop="uvloop",
            http="httptools",
        )

    @staticmethod
    def start(
        sim_path: str | Path, host: str = "127.0.0.1", preferred_port: int = 5420
    ):
        if not Path(sim_path).is_file():
            raise FileNotFoundError(f"Simulation file '{sim_path}' does not exist.")
        server = SimViewServer(sim_path=sim_path)
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
