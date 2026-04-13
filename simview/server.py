import json
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import socketio
import uvicorn
from importlib.resources import files
from simview.utils import find_free_port

TEMPLATES = str(files("simview").joinpath("templates"))
STATIC = str(files("simview").joinpath("static"))


class SimViewServer:
    def __init__(self, sim_path: str | Path):
        self.sim_path = Path(sim_path)

        # Initialize Socket.IO AsyncServer
        self.sio = socketio.AsyncServer(
            async_mode="asgi",
            cors_allowed_origins="*",
            max_http_buffer_size=1000 * 1024 * 1024,  # 1000MB (1GB)
        )

        # Initialize FastAPI app
        self.app = FastAPI()

        # Mount static files and setup templates
        self.app.mount("/static", StaticFiles(directory=STATIC), name="static")
        self.templates = Jinja2Templates(directory=TEMPLATES)

        # Combine SIO and FastAPI into one ASGI application
        self.socket_app = socketio.ASGIApp(self.sio, self.app)

        # Load simulation data once to avoid redundant I/O and memory spikes
        self.model_data = None
        self.states_data = None
        self._load_data()

        self.setup_routes()
        self.setup_socket_handlers()

    def _load_data(self):
        try:
            print(f"Loading simulation data from {self.sim_path}...")
            with open(self.sim_path, "r") as f:
                data = json.load(f)
                self.model_data = data.get("model")
                self.states_data = data.get("states")
            print("Simulation data loaded successfully.")
        except Exception as e:
            print(f"Error loading simulation data: {e}")
            self.model_data = None
            self.states_data = None

    def setup_routes(self):
        @self.app.get("/")
        async def index(request: Request):
            return self.templates.TemplateResponse(
                request=request, name="index.html", context={"request": request}
            )

    def setup_socket_handlers(self):
        @self.sio.on("connect")
        async def handle_connect(sid, environ):
            print(f"Client connected: {sid}")

        @self.sio.on("disconnect")
        async def handle_disconnect(sid):
            print(f"Client disconnected: {sid}")

        @self.sio.on("get_model")
        async def handle_get_model(sid):
            if self.model_data is not None:
                await self.sio.emit("model", self.model_data, to=sid)
            else:
                await self.sio.emit(
                    "error", {"message": "Model data not available"}, to=sid
                )

        @self.sio.on("get_states")
        async def handle_get_states(sid):
            if self.states_data is not None:
                await self.sio.emit("states", self.states_data, to=sid)
            else:
                await self.sio.emit(
                    "error", {"message": "States data not available"}, to=sid
                )

    def run(self, debug: bool = False, host: str = "127.0.0.1", port: int = 5420):
        uvicorn.run(
            self.socket_app,
            host=host,
            port=port,
            log_level="debug" if debug else "info",
        )

    @staticmethod
    def start(
        sim_path: str | Path, host: str = "127.0.0.1", preferred_port: int = 5420
    ):
        if not Path(sim_path).is_file():
            print(f"Error: Simulation file '{sim_path}' does not exist.")
            exit(1)
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
