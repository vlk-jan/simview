from pathlib import Path
import json
import torch

from .model import (
    SimViewModel,
    SimViewTerrain,
    SimViewBody,
    BodyShapeType,  # If used directly by users of SimulationData for body creation
    OptionalBodyStateAttribute,  # If used directly
    SimViewStaticObject,
)
from .state import SimViewBodyState


class SimulationScene:
    def __init__(
        self,
        batch_size: int,
        scalar_names: list[str],
        dt: float,
        collapse: bool = False,
        terrain: SimViewTerrain | None = None,
        bodies: dict[str, SimViewBody] | None = None,
        static_objects: dict[str, SimViewStaticObject] | None = None,
    ) -> None:
        """
        Initializes the simulation data container.
        Manages the SimViewModel and the time-series states.
        """
        self.model = SimViewModel(
            batch_size=batch_size,
            scalar_names=scalar_names,
            dt=dt,
            collapse=collapse,
            terrain=terrain,
            bodies=bodies if bodies is not None else {},
            static_objects=static_objects if static_objects is not None else {},
        )
        self.states: list[dict] = []

    def add_state(
        self,
        time: float,
        body_states: list[SimViewBodyState],
        scalar_values: dict[str, torch.Tensor | list] | None = None,
    ) -> None:
        """
        Adds a new state (snapshot in time) to the simulation data.
        """
        if self.model.scalar_names:  #
            if scalar_values is None:
                raise ValueError(
                    "Scalar values must be provided when scalar_names are defined in the model."
                )
            if set(scalar_values.keys()) != set(self.model.scalar_names):  #
                raise ValueError(
                    "Provided scalar_values keys do not match scalar_names in the model."
                )

            processed_scalars = {}
            for k, v in scalar_values.items():
                if isinstance(v, torch.Tensor):
                    processed_scalars[k] = v.tolist()  #
                elif isinstance(v, list):
                    processed_scalars[k] = v
                else:
                    raise TypeError(
                        f"Scalar value for '{k}' must be a torch.Tensor or a list."
                    )
        else:
            processed_scalars = {}
            if scalar_values:
                print(
                    "Warning: scalar_values provided but no scalar_names defined in the model. These values will be ignored."
                )

        self.states.append(
            {
                "time": time,
                "bodies": [state.to_json() for state in body_states],  #
                **processed_scalars,
            }
        )

    def save(self, filepath: str | Path) -> None:
        """
        Exports the complete simulation data (model and states) to a JSON file.
        """
        if not self.model.is_complete:  #
            raise ValueError(
                "Cannot save data: The simulation model is not complete (e.g., terrain might be missing)."
            )

        output_path = Path(filepath)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            complete_json = {
                "model": self.model.to_json(),
                "states": self.states,
            }
            with open(output_path, "w") as f:
                json.dump(complete_json, f)
            print(f"Simulation data successfully saved to {output_path}")
        except Exception as e:
            print(f"Error saving simulation data to {output_path}: {e}")
            raise

    def create_terrain(
        self,
        heightmap: torch.Tensor,
        normals: torch.Tensor,
        x_lim: tuple[float, float],
        y_lim: tuple[float, float],
    ) -> None:
        """Adds terrain to the simulation model."""
        self.model.create_terrain(heightmap, normals, x_lim, y_lim)  #

    def add_terrain_object(self, terrain: SimViewTerrain) -> None:
        """Adds a pre-configured SimViewTerrain object to the model."""
        self.model.add_terrain(terrain)  #

    def create_body(
        self,
        body_name: str,
        shape_type: BodyShapeType,
        available_attributes: list[OptionalBodyStateAttribute | str] | None = None,
        **kwargs,
    ) -> None:
        """Creates and adds a dynamic body to the simulation model."""
        self.model.create_body(
            body_name, shape_type, available_attributes=available_attributes, **kwargs
        )  #

    def add_body_object(self, body: SimViewBody) -> None:
        """Adds a pre-configured SimViewBody object to the model."""
        self.model.add_body(body)  #

    def create_static_object_singleton(
        self, name: str, shape_type: BodyShapeType, **kwargs
    ) -> None:
        """Creates and adds a singleton static object to the simulation model."""
        self.model.create_static_object_singleton(name, shape_type, **kwargs)  #

    def create_static_object_batched(
        self, name: str, shape_type: BodyShapeType, shapes_kwargs: list[dict[str, any]]
    ) -> None:
        """Creates and adds a batched static object to the simulation model."""
        self.model.create_static_object_batched(name, shape_type, shapes_kwargs)  #

    def add_static_object_instance(self, static_object: SimViewStaticObject) -> None:
        """Adds a pre-configured SimViewStaticObject to the model."""
        self.model.add_static_object(static_object)  #

