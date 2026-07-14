import gzip
import json
import logging
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
from .state import (
    TRAJECTORY_VECTOR_FIELDS,
    BodyTrajectory,
    LocalTransformLike,
    SimViewBodyState,
)
from .utils import read_maybe_gzipped_bytes

logger = logging.getLogger("simview.scene")


def _to_f4(value) -> np.ndarray:
    """Coerce a tensor / array / nested list to a contiguous little-endian float32 array."""
    if isinstance(value, torch.Tensor):
        value = value.detach().cpu().numpy()
    return np.ascontiguousarray(np.asarray(value, dtype="<f4"))


def _iter_names(name: str | list[str]):
    """Yield each individual body name, whether `name` is a single string or
    a list of names sharing one transform."""
    return name if isinstance(name, list) else [name]


def _name_label(name: str | list[str]) -> str:
    """Human-readable label for `name` in error messages."""
    return ", ".join(name) if isinstance(name, list) else name


def _validate_body_name(name: str | list[str], model: SimViewModel) -> None:
    """Raise ValueError if `name` (or any name in it, when a list) isn't a
    body defined in `model`."""
    if isinstance(name, list) and not name:
        raise ValueError("Body name list must not be empty.")
    for n in _iter_names(name):
        if n not in model.bodies:
            valid = sorted(model.bodies)
            raise ValueError(
                f"Unknown body '{n}'; not defined in the model. "
                f"Valid body names: {valid}."
            )


def _validate_not_rigid(name: str | list[str], model: SimViewModel) -> None:
    """Raise ValueError if `name` (or any name in it, when a list) refers to a
    rigidly-attached body (`local_transform` set on the model). Such bodies
    never receive per-frame data -- their pose is derived by the viewer from
    their parent's current pose plus the fixed offset -- so passing state data
    for them here would be silently ignored on the wire, which is almost
    certainly a mistake."""
    for n in _iter_names(name):
        body = model.bodies.get(n)
        if body is not None and body.local_transform is not None:
            raise ValueError(
                f"Body '{n}' is rigidly attached (local_transform is set on the "
                "model) and must not be given per-frame state data; its pose is "
                "derived from its parent every frame."
            )


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

    @classmethod
    def from_dict(cls, d: dict) -> "SimulationScene":
        """Reconstruct a SimulationScene from the dict produced by `save`/`to_json`
        (i.e. the parsed `{"model": ..., "states": ...}` document).

        Binary `__b64__`-encoded fields inside `states` (e.g. from
        ``add_trajectory(binary=True)``) are left as-is, matching the on-disk
        wire format, so a subsequent `save()` reproduces the same bytes for
        those fields without a decode/re-encode round trip.
        """
        try:
            model_dict = d["model"]
            states = d["states"]
        except KeyError as e:
            raise ValueError(f"Scene dict is missing required key: {e}") from e

        model = SimViewModel.from_dict(model_dict)
        scene = cls(
            batch_size=model.batch_size,
            scalar_names=model.scalar_names,
            dt=model.dt,
            collapse=model.collapse,
            terrain=model.terrain,
            bodies=model.bodies,
            static_objects=model.static_objects,
            batch_names=model.batch_names,
        )
        scene.states = list(states)
        return scene

    @classmethod
    def load(cls, path: str | Path) -> "SimulationScene":
        """Load a SimulationScene previously written by `save`.

        Transparently reads gzip-compressed files (detected by magic bytes,
        regardless of extension) as well as plain JSON. Enables round-tripping
        from Python: ``SimulationScene.load(p).save(p2)``.
        """
        data = json.loads(read_maybe_gzipped_bytes(path))
        return cls.from_dict(data)

    def add_state(
        self,
        time: float,
        body_states: list[SimViewBodyState],
        scalar_values: dict[str, torch.Tensor | np.ndarray | list] | None = None,
    ) -> None:
        """
        Adds a new state (snapshot in time) to the simulation data.
        """
        for state in body_states:
            _validate_body_name(state.body_name, self.model)
            _validate_not_rigid(state.body_name, self.model)

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
                if isinstance(v, (torch.Tensor, np.ndarray)):
                    processed_scalars[k] = v.tolist()
                elif isinstance(v, list):
                    processed_scalars[k] = v
                else:
                    raise TypeError(
                        f"Scalar value for '{k}' must be a torch.Tensor, "
                        "numpy.ndarray, or a list."
                    )
        else:
            processed_scalars = {}
            if scalar_values:
                logger.warning(
                    "scalar_values provided but no scalar_names defined in the "
                    "model. These values will be ignored."
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
        scalar_values: dict[str, torch.Tensor | np.ndarray | list] | None = None,
        binary: bool = True,
    ) -> None:
        """Append an entire time-series in one call.

        Equivalent to looping ``add_state`` over ``T`` frames, but converts each
        body's pose/vector tensors once (vectorised) instead of per frame, which
        is dramatically faster for long trajectories. With ``binary=True`` the
        numeric per-body fields (``bodyTransform`` and any provided vectors) are
        packed as float32 ``__b64__`` blobs, shrinking the output file and the
        parse cost; the viewer and :func:`merge_simulation_files` decode these
        transparently. Set ``binary=False`` to emit plain JSON lists. A body's
        ``contacts`` (if provided on its :class:`BodyTrajectory`) are ragged and
        always emitted as plain JSON per frame, using the same encoding as
        ``SimViewBodyState`` / ``add_state``.

        Args:
            times: sequence of length ``T`` of snapshot times (seconds).
            trajectories: one :class:`BodyTrajectory` per body; each body must
                already exist in the model.
            scalar_values: for a scene with ``scalar_names``, maps each name to a
                ``(T, B)`` (or ``(T,)`` when ``B == 1``) series.
        """
        times = [
            float(t)
            for t in (
                times.tolist()
                if isinstance(times, (torch.Tensor, np.ndarray))
                else times
            )
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
                logger.warning(
                    "scalar_values provided but no scalar_names defined; ignoring."
                )
            scalars = {}

        # Pre-normalize every field to (T, B, k) float32 up front so the per-frame
        # loop below only slices and encodes. Contacts are ragged (ints per body
        # per batch), so they're normalized separately into a plain length-T list.
        prepared: list[tuple[str | list[str], dict[str, np.ndarray]]] = []
        prepared_contacts: list[tuple[str | list[str], list]] = []
        for traj in trajectories:
            _validate_body_name(traj.name, self.model)
            _validate_not_rigid(traj.name, self.model)
            label = _name_label(traj.name)
            fields = {
                "bodyTransform": np.concatenate(
                    [
                        _as_tbk(traj.positions, T, B, 3, "positions", label),
                        _as_tbk(traj.orientations, T, B, 4, "orientations", label),
                    ],
                    axis=-1,
                )
            }
            for attr, wire_key in TRAJECTORY_VECTOR_FIELDS.items():
                value = getattr(traj, attr)
                if value is not None:
                    fields[wire_key] = _as_tbk(value, T, B, 3, attr, label)
            prepared.append((traj.name, fields))

            if traj.contacts is not None:
                if len(traj.contacts) != T:
                    raise ValueError(
                        f"{label}.contacts has {len(traj.contacts)} timesteps; "
                        f"expected {T} (from times)."
                    )
                contacts_per_t = [
                    SimViewBodyState._process_contacts(frame) for frame in traj.contacts
                ]
                prepared_contacts.append((traj.name, contacts_per_t))

        def encode(slice_: np.ndarray):
            return _encode_blob(slice_) if binary else slice_.tolist()

        # dict keys must be hashable, so group names (lists) are keyed by tuple.
        def _name_key(name):
            return tuple(name) if isinstance(name, list) else name

        contacts_by_name = {
            _name_key(name): contacts for name, contacts in prepared_contacts
        }
        for t in range(T):
            bodies = [
                {
                    "name": name,
                    **{key: encode(arr[t]) for key, arr in fields.items()},
                    **(
                        {"contacts": contacts_by_name[_name_key(name)][t]}
                        if _name_key(name) in contacts_by_name
                        else {}
                    ),
                }
                for name, fields in prepared
            ]
            state = {"time": times[t], "bodies": bodies}
            for name, arr in scalars.items():
                state[name] = arr[t].tolist()
            self.states.append(state)

    def save(self, filepath: str | Path, compress: bool = False) -> None:
        """
        Exports the complete simulation data (model and states) to a JSON file.
        Uses a streaming approach to reduce memory spikes for large simulations.

        Args:
            filepath: Destination path. If it ends in ``.gz`` the output is
                gzip-compressed regardless of `compress`.
            compress: If True, gzip-compress the output (useful for large
                simulations, which can reach 100+ MB as plain JSON). If
                `filepath` doesn't already end in ``.gz``, the suffix is
                appended so the extension reflects the actual file contents.
        """
        if not self.model.is_complete:
            raise ValueError(
                "Cannot save data: The simulation model is not complete (e.g., terrain might be missing)."
            )

        # Reconcile available_attributes with actual data across all states
        # (an attribute may be absent from earlier frames but present later)
        if self.states:
            provided_attrs_by_body = {}
            for state in self.states:
                for body_data in state.get("bodies", []):
                    name = body_data.get("name")
                    if name:
                        # Everything in the body's dict other than name and bodyTransform is an optional attribute
                        provided = set(body_data.keys()) - {"name", "bodyTransform"}
                        for n in _iter_names(name):
                            provided_attrs_by_body.setdefault(n, set()).update(provided)

            for name, body in self.model.bodies.items():
                if name in provided_attrs_by_body:
                    provided = provided_attrs_by_body[name]
                    if provided:
                        body.available_attributes = [
                            OptionalBodyStateAttribute(k) for k in provided
                        ]
                    else:
                        body.available_attributes = None

        output_path = Path(filepath)
        if compress and output_path.suffix != ".gz":
            output_path = output_path.with_name(output_path.name + ".gz")
        compress = compress or output_path.suffix == ".gz"
        output_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            logger.info("Saving simulation data to %s...", output_path)
            open_fn = (
                (lambda p: gzip.open(p, "wt")) if compress else (lambda p: open(p, "w"))
            )
            with open_fn(output_path) as f:
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
            logger.info("Simulation data successfully saved to %s", output_path)
        except Exception:
            logger.exception("Error saving simulation data to %s", output_path)
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
        parent: str | None = None,
        local_transform: LocalTransformLike | None = None,
        **kwargs,
    ) -> None:
        """Creates and adds a dynamic body to the simulation model.

        ``parent``/``local_transform`` attach this body to another body already
        in the model, instead of it moving in world space:

        - Rigid attachment (e.g. a wheel bolted to a chassis): pass both
          ``parent`` and ``local_transform`` (a constant ``[x, y, z, w, qx, qy,
          qz]`` offset). Never call ``add_state``/``add_trajectory`` for this
          body afterwards -- its world pose is derived by the viewer every
          frame from the parent's current pose plus this fixed offset.
        - Articulated attachment (e.g. an arm joint): pass only ``parent``.
          Keep supplying this body's pose every frame via ``add_state``/
          ``add_trajectory`` as usual -- it's just interpreted as local to the
          parent's current-frame pose instead of world space.
        """
        self.model.create_body(
            body_name,
            shape_type,
            available_attributes=available_attributes,
            parent=parent,
            local_transform=local_transform,
            **kwargs,
        )

    def add_body_object(self, body: SimViewBody) -> None:
        """Adds a pre-configured SimViewBody object to the model. See
        `create_body` for the meaning of `body.parent`/`body.local_transform`."""
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
            self.model.terrain.friction_data = None
            self.model.terrain.stiffness_data = None
        logger.info("SimulationScene: Internal data cleared.")
