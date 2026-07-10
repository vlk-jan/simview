import gc
from pathlib import Path

from simview.server import SimViewServer
from simview.utils import find_free_port

from .scene import SimulationScene


class SimViewLauncher:
    def __init__(
        self,
        source: SimulationScene | str | Path,
    ) -> None:
        """
        Initializes the visualizer.
        - If source is a SimulationScene: it is handed to the server in memory (no
          temporary file), and its internal data is cleared after the server stops.
        - If source is a path: it is used directly.
        """
        self._scene: SimulationScene | None = None
        self._sim_file_path: Path | None = None

        if isinstance(source, SimulationScene):
            if (
                source.model is None
                or not source.model.is_complete
                or source.states is None
            ):
                raise ValueError(
                    "Cannot initialize visualizer: The provided SimulationScene "
                    "is incomplete, has no states, or has already been cleared."
                )
            self._scene = source
        elif isinstance(source, (str, Path)):
            self._sim_file_path = Path(source)
            if not self._sim_file_path.exists():
                raise FileNotFoundError(
                    f"Simulation JSON file not found at: {self._sim_file_path}"
                )
            print(
                f"SimViewLauncher: Using existing simulation file: {self._sim_file_path}"
            )
        else:
            raise TypeError(
                "Source for SimViewLauncher must be a SimulationScene object or a file path (str/Path)."
            )

    def launch(self, host: str = "127.0.0.1", preferred_port: int = 5420) -> None:
        """
        Launches the SimViewServer, then clears the in-memory scene (if any).
        """
        try:
            if self._scene is not None:
                # Serialize the scene once and hand it to the server directly,
                # avoiding a temp-file write + read-back round-trip.
                print("SimViewLauncher: Serving in-memory SimulationScene")
                data = {
                    "model": self._scene.model.to_json(),
                    "states": self._scene.states,
                }
                server = SimViewServer(data=data)
                port = find_free_port(host, preferred_port)
                if port != preferred_port:
                    print(
                        f"Preferred port {preferred_port} is not available. "
                        f"Using port {port} instead."
                    )
                server.run(host=host, port=port)
            else:
                SimViewServer.start(
                    sim_path=self._sim_file_path,
                    host=host,
                    preferred_port=preferred_port,
                )
        except KeyboardInterrupt:
            print("\nSimView server stopped by user.")
        except Exception as e:
            print(f"Error starting SimView server: {e}")
        finally:
            self.cleanup()

    def cleanup(self) -> None:
        """
        Clears the in-memory scene's data. Safe to call multiple times.
        """
        if self._scene is not None:
            print("SimViewLauncher: Clearing source SimulationScene internal data...")
            self._scene._clear_internal_data()
            self._scene = None
            gc.collect()

    def __enter__(self) -> "SimViewLauncher":
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.cleanup()
