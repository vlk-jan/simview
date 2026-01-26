import os
from simview.server import SimViewServer  # Make sure this import is correct
import tempfile  # For creating temporary files if needed

from .scene import SimulationScene
from pathlib import Path

# If CACHE_DIR is used by SimViewVisualizer for its temporary files:
CACHE_DIR = ".simview_cache"  # Already defined above or manage scope


class SimViewLauncher:
    def __init__(
        self,
        source: SimulationScene | str | Path,
    ) -> None:
        """
        Initializes the visualizer.
        - If source is SimulationScene: it's saved to a temporary file, and the source object
          will be marked for data clearing after visualization.
        - If source is a path: it's used directly.
        No persistent caching is used.
        """
        self._sim_file_path: Path | None = None
        self._is_temp_file = False
        self._source_data_object_to_clear: SimulationScene | None = None

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

            # Create a temporary file. mkstemp is better for ensuring it's creatable.
            # We get a file descriptor and a path. Close the fd, then use the path.
            fd, temp_path_str = tempfile.mkstemp(suffix=".json", prefix="simview_viz_")
            os.close(fd)  # Close the file descriptor, so source.save can open it

            self._sim_file_path = Path(temp_path_str)
            self._is_temp_file = True

            print(
                f"SimViewLauncher: Saving in-memory SimulationScene to temporary file {self._sim_file_path}"
            )
            try:
                source.save(self._sim_file_path)
                # If save is successful, mark the source object for clearing later
                self._source_data_object_to_clear = source
            except Exception as e:
                # If saving fails, clean up the temp file immediately
                if self._sim_file_path.exists():
                    self._sim_file_path.unlink()
                raise ValueError(
                    f"Failed to save SimulationScene to temporary file: {e}"
                )

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
                "Source for SimViewLauncher must be a SimulationData object or a file path (str/Path)."
            )

    def launch(self) -> None:
        """
        Launches the SimViewServer and clears RAM if data was from a SimulationScene object.
        """
        if not self._sim_file_path or not self._sim_file_path.exists():
            print(
                f"Error: Simulation file {self._sim_file_path} not found or not specified for visualization."
            )
            return

        print(f"Starting SimLauncher with data from: {self._sim_file_path}")
        try:
            # This call is assumed to be potentially blocking or to launch a separate process/thread.
            # Memory clearing should happen after this call conceptually, or if it's non-blocking,
            # immediately after ensuring the server has picked up the file.
            SimViewServer.start(sim_path=self._sim_file_path)

        finally:  # Ensure data clearing and temp file cleanup happens even if server fails to start (if start() raises)
            # or after server stops (if start() is blocking).
            if self._source_data_object_to_clear is not None:
                print(
                    "SimViewLauncher: Clearing data from the source SimulationData object post-visualization."
                )
                self._source_data_object_to_clear._clear_internal_data()
                # Remove the visualizer's reference. If the user also drops their reference,
                # the SimulationData object (now empty) will be garbage collected.
                self._source_data_object_to_clear = None
                gc.collect()  # Encourage garbage collection
                print(
                    "SimViewLauncher: Source data object cleared and garbage collection triggered."
                )

            # Temporary file cleanup is handled in __del__ if visualize() is the end of life,
            # but if visualize can be called multiple times (not logical here), cleanup should be more careful.
            # For a one-shot visualize, __del__ is fine. If the server is non-blocking and python script continues,
            # then __del__ might be too late if the script ends quickly.
            # Let's stick to __del__ for temp file cleanup as per common patterns with temp files
            # passed to other processes.

    def __del__(self):
        """
        Cleanup temporary file if one was created by this visualizer instance.
        """
        if self._is_temp_file and self._sim_file_path and self._sim_file_path.exists():
            try:
                print(f"Cleaning up temporary visualizer file: {self._sim_file_path}")
                self._sim_file_path.unlink()
            except OSError as e:
                print(
                    f"Warning: Could not delete temporary file {self._sim_file_path}. "
                    f"It might be in use or already deleted. Error: {e}"
                )

