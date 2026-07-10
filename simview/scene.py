import json
from pathlib import Path
from typing import Any

import numpy as np
import torch

from .model import (
    BodyShapeType,  # If used directly by users of SimulationData for body creation
    OptionalBodyStateAttribute,  # If used directly
    SimViewBody,
    SimViewModel,
    SimViewStaticObject,
    SimViewTerrain,
    _encode_blob,
)
from .state import TRAJECTORY_VECTOR_FIELDS, BodyTrajectory, SimViewBodyState


def _to_f4(value) -> np.ndarray:
    """Coerce a tensor / array / nested list to a contiguous little-endian float32 array."""
    if isinstance(value, torch.Tensor):
        value = value.detach().cpu().numpy()
    return np.ascontiguousarray(np.asarray(value, dtype="<f4"))


def _as_tbk(value, T: int, B: int, k: int, field: str, body: str) -> np.ndarray:
    """Normalize a per-body trajectory field to shape (T, B, k), float32.

    Accepts (T, B, k), or (T, k) when B == 1. Validates T, B and the trailing
    width so mistakes surface here rather than as a corrupt scene.
    """
    arr = _to_f4(value)
    if arr.ndim == 2:  # (T, k) -> single batch
        arr = arr[:, None, :]
    if arr.ndim != 3:
        raise ValueError(
            f"{body}.{field} must have shape (T, {k}) or (T, B, {k}); got {arr.shape}."
        )
    Tt, Bb, kk = arr.shape
    if kk != k:
        raise ValueError(f"{body}.{field} last dim is {kk}; expected {k}.")
    if Tt != T:
        raise ValueError(
            f"{body}.{field} has {Tt} timesteps; expected {T} (from times)."
        )
    if Bb != B:
        raise ValueError(
            f"{body}.{field} has batch dim {Bb}; expected {B} "
            f"(use (T, {k}) only when batch size is 1)."
        )
    return np.ascontiguousarray(arr)


def _as_tb(value, T: int, B: int, name: str) -> np.ndarray:
    """Normalize a scalar time-series to shape (T, B). Accepts (T,) when B == 1."""
    arr = _to_f4(value)
    if arr.ndim == 1:
        arr = arr[:, None]
    if arr.shape != (T, B):
        raise ValueError(
            f"scalar '{name}' must have shape (T,) or (T, B) = ({T}, {B}); got {arr.shape}."
        )
    return arr


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
        batch_names: list[str] | None = None,
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
            batch_names=batch_names,
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
        if self.model.scalar_names:
            if scalar_values is None:
                raise ValueError(
                    "Scalar values must be provided when scalar_names are defined in the model."
                )
            if set(scalar_values.keys()) != set(self.model.scalar_names):
                raise ValueError(
                    "Provided scalar_values keys do not match scalar_names in the model."
                )

            processed_scalars = {}
            for k, v in scalar_values.items():
                if isinstance(v, torch.Tensor):
                    processed_scalars[k] = v.tolist()
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
                "bodies": [state.to_json() for state in body_states],
                **processed_scalars,
            }
        )

    def add_trajectory(
        self,
        times,
        trajectories: list[BodyTrajectory],
        scalar_values: dict[str, torch.Tensor | list] | None = None,
        binary: bool = True,
    ) -> None:
        """Append an entire time-series in one call.

        Equivalent to looping ``add_state`` over ``T`` frames, but converts each
        body's pose/vector tensors once (vectorised) instead of per frame, which
        is dramatically faster for long trajectories. With ``binary=True`` the
        numeric per-body fields (``bodyTransform`` and any provided vectors) are
        packed as float32 ``__b64__`` blobs, shrinking the output file and the
        parse cost; the viewer and :func:`merge_simulation_files` decode these
        transparently. Set ``binary=False`` to emit plain JSON lists.

        Args:
            times: sequence of length ``T`` of snapshot times (seconds).
            trajectories: one :class:`BodyTrajectory` per body; each body must
                already exist in the model.
            scalar_values: for a scene with ``scalar_names``, maps each name to a
                ``(T, B)`` (or ``(T,)`` when ``B == 1``) series.
        """
        times = [
            float(t)
            for t in (times.tolist() if isinstance(times, torch.Tensor) else times)
        ]
        T = len(times)
        B = self.model.batch_size

        if self.model.scalar_names:
            if scalar_values is None or set(scalar_values) != set(
                self.model.scalar_names
            ):
                raise ValueError(
                    "scalar_values keys must match the model's scalar_names."
                )
            scalars = {
                name: _as_tb(scalar_values[name], T, B, name)
                for name in self.model.scalar_names
            }
        else:
            if scalar_values:
                print(
                    "Warning: scalar_values provided but no scalar_names defined; ignoring."
                )
            scalars = {}

        # Pre-normalize every field to (T, B, k) float32 up front so the per-frame
        # loop below only slices and encodes.
        prepared: list[tuple[str, dict[str, np.ndarray]]] = []
        for traj in trajectories:
            if traj.name not in self.model.bodies:
                raise ValueError(
                    f"Unknown body '{traj.name}'; create it in the model before "
                    "adding its trajectory."
                )
            fields = {
                "bodyTransform": np.concatenate(
                    [
                        _as_tbk(traj.positions, T, B, 3, "positions", traj.name),
                        _as_tbk(traj.orientations, T, B, 4, "orientations", traj.name),
                    ],
                    axis=-1,
                )
            }
            for attr, wire_key in TRAJECTORY_VECTOR_FIELDS.items():
                value = getattr(traj, attr)
                if value is not None:
                    fields[wire_key] = _as_tbk(value, T, B, 3, attr, traj.name)
            prepared.append((traj.name, fields))

        def encode(slice_: np.ndarray):
            return _encode_blob(slice_) if binary else slice_.tolist()

        for t in range(T):
            bodies = [
                {"name": name, **{key: encode(arr[t]) for key, arr in fields.items()}}
                for name, fields in prepared
            ]
            state = {"time": times[t], "bodies": bodies}
            for name, arr in scalars.items():
                state[name] = arr[t].tolist()
            self.states.append(state)

    def save(self, filepath: str | Path) -> None:
        """
        Exports the complete simulation data (model and states) to a JSON file.
        Uses a streaming approach to reduce memory spikes for large simulations.
        """
        if not self.model.is_complete:
            raise ValueError(
                "Cannot save data: The simulation model is not complete (e.g., terrain might be missing)."
            )

        output_path = Path(filepath)
        output_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            print(f"Saving simulation data to {output_path}...")
            with open(output_path, "w") as f:
                f.write("{\n")
                f.write('  "model": ')
                json.dump(self.model.to_json(), f, indent=2)
                f.write(",\n")
                f.write('  "states": [\n')
                for i, state in enumerate(self.states):
                    if i > 0:
                        f.write(",\n")
                    f.write("    ")
                    json.dump(state, f)
                f.write("\n  ]\n}")
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
        friction_map: torch.Tensor | None = None,
        stiffness_map: torch.Tensor | None = None,
    ) -> None:
        """Adds terrain to the simulation model."""
        self.model.create_terrain(
            heightmap,
            normals,
            x_lim,
            y_lim,
            friction_map=friction_map,
            stiffness_map=stiffness_map,
        )

    def add_terrain_object(self, terrain: SimViewTerrain) -> None:
        """Adds a pre-configured SimViewTerrain object to the model."""
        self.model.add_terrain(terrain)

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
        )

    def add_body_object(self, body: SimViewBody) -> None:
        """Adds a pre-configured SimViewBody object to the model."""
        self.model.add_body(body)

    def create_static_object_singleton(
        self, name: str, shape_type: BodyShapeType, **kwargs
    ) -> None:
        """Creates and adds a singleton static object to the simulation model."""
        self.model.create_static_object_singleton(name, shape_type, **kwargs)

    def create_static_object_batched(
        self, name: str, shape_type: BodyShapeType, shapes_kwargs: list[dict[str, Any]]
    ) -> None:
        """Creates and adds a batched static object to the simulation model."""
        self.model.create_static_object_batched(name, shape_type, shapes_kwargs)

    def add_static_object_instance(self, static_object: SimViewStaticObject) -> None:
        """Adds a pre-configured SimViewStaticObject to the model."""
        self.model.add_static_object(static_object)

    def _clear_internal_data(self) -> None:
        """
        Clears the stored simulation states and model data to free up memory.
        """
        self.states = []
        # Clear large terrain data if present
        if self.model and self.model.terrain:
            self.model.terrain.height_data = []
            self.model.terrain.normals = []
        print("SimulationScene: Internal data cleared.")
