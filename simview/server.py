import json
from pathlib import Path

from flask import Flask
from flask import render_template
from flask_socketio import SocketIO, emit
from importlib.resources import files
from simview.utils import find_free_port

TEMPLATES = files("simview").joinpath("templates")
STATIC = files("simview").joinpath("static")


class SimViewServer:
    def __init__(self, sim_path: str | Path):
        self.sim_path = Path(sim_path)
        self.app = Flask(
            __name__, template_folder=str(TEMPLATES), static_folder=str(STATIC)
        )
        self.socketio = SocketIO(
            self.app,
            json=json,
            cors_allowed_origins="*",
            max_http_buffer_size=100 * 1024 * 1024,  # 100MB
        )

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
        @self.app.route("/")
        def index():
            return render_template("index.html")

    def setup_socket_handlers(self):
        @self.socketio.on("connect")
        def handle_connect():
            print("Client connected")

        @self.socketio.on("disconnect")
        def handle_disconnect():
            print("Client disconnected")

        @self.socketio.on("get_model")
        def handle_get_model():
            if self.model_data is not None:
                emit("model", self.model_data)
            else:
                emit("error", {"message": "Model data not available"})

        @self.socketio.on("get_states")
        def handle_get_states():
            if self.states_data is not None:
                emit("states", self.states_data)
            else:
                emit("error", {"message": "States data not available"})

    def run(self, debug: bool = False, host: str = "127.0.0.1", port: int = 5420):
        self.socketio.run(self.app, debug=debug, host=host, port=port, log_output=True)

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
