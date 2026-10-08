import gzip
import json
import logging
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import Any, cast

import numpy as np
import torch

from .columnar import (
    body_key,
    columnarize_states,
    expand_columnar_states,
    inline_blob,
    is_columnar,
    write_static_bundle,
)
from .model import (
    BodyShapeType,  # If used directly by users of SimulationData for body creation
    OptionalBodyStateAttribute,  # If used directly
    SimViewBody,
    SimViewEpisode,
    SimViewModel,
    SimViewStaticObject,
    SimViewTerrain,
    _encode_blob,
    _validate_episodes,
)
from .server import SimViewServer, ViewerHandle
from .state import (
    TRAJECTORY_VECTOR_FIELDS,
    BodyTrajectory,
    LocalTransformLike,
    SimViewBodyState,
)
from .utils import iter_names, read_maybe_gzipped_bytes

logger = logging.getLogger("simview.scene")


def _to_f4(value) -> np.ndarray:
    """Coerce a tensor / array / nested list to a contiguous little-endian float32 array."""
    if isinstance(value, torch.Tensor):
        value = value.detach().cpu().numpy()
    return np.ascontiguousarray(np.asarray(value, dtype="<f4"))


def _name_label(name: str | list[str]) -> str:
    """Human-readable label for `name` in error messages."""
    return ", ".join(name) if isinstance(name, list) else name


def _validate_body_name(name: str | list[str], model: SimViewModel) -> None:
    """Raise ValueError if `name` (or any name in it, when a list) isn't a
    body defined in `model`."""
    if isinstance(name, list) and not name:
        raise ValueError("Body name list must not be empty.")
    for n in iter_names(name):
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
    for n in iter_names(name):
        body = model.bodies.get(n)
        if body is not None and body.local_transform is not None:
            raise ValueError(
                f"Body '{n}' is rigidly attached (local_transform is set on the "
                "model) and must not be given per-frame state data; its pose is "
                "derived from its parent every frame."
            )


def _batch_rows(value) -> int:
    """Per-batch row count of a processed state field (a nested list is one
    row per batch; a flat vector is one row)."""
    return len(value) if value and isinstance(value[0], list) else 1


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
        dt: float | None,
        collapse: bool = False,
        terrain: SimViewTerrain | None = None,
        bodies: dict[str, SimViewBody] | None = None,
        static_objects: dict[str, SimViewStaticObject] | None = None,
        batch_names: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        episodes: list[SimViewEpisode] | None = None,
        viewer_defaults: dict[str, Any] | None = None,
    ) -> None:
        """
        Initializes the simulation data container.
        Manages the SimViewModel and the time-series states.

        `metadata` is free-form, JSON-serializable run provenance (e.g. engine
        name, checkpoint path, git commit, CLI args) with no meaning to the
        viewer -- it's carried through to `simview info` and the browser so a
        saved scene stays self-describing. Can also be set/updated later via
        `self.model.metadata`.

        `episodes` marks the frames an episodic (e.g. RL) recording resets at.
        Usually easier to build up as you go with `mark_episode()` than to pass
        here up front.

        `viewer_defaults` declares the viewer's initial UI state (hidden point
        clouds, collapsed panels, open/closed GUI folders, ...); see
        docs/dev/json-format.md for the supported keys.
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
            metadata=metadata,
            episodes=episodes,
            viewer_defaults=viewer_defaults,
        )
        self.states: list[dict] = []

    def mark_episode(
        self, label: str | None = None, start_index: int | None = None
    ) -> SimViewEpisode:
        """Mark the start of an episode in this scene's timeline.

        Call it right before adding the first frame of a new episode (a reset),
        which is what the default `start_index` -- the index the next added
        frame will land at -- means::

            for episode in range(num_episodes):
                scene.mark_episode(label=f"episode {episode}")
                for t in range(episode_length):
                    scene.add_state(...)

        Pass `start_index` explicitly to annotate an already-recorded scene.
        Episode starts must be strictly increasing; a repeated or out-of-order
        index raises ValueError. Returns the created `SimViewEpisode`.
        """
        if start_index is None:
            start_index = len(self.states)
        episode = SimViewEpisode(start_index=start_index, label=label)
        episodes = list(self.model.episodes or [])
        episodes.append(episode)
        _validate_episodes(episodes)
        self.model.episodes = episodes
        return episode

    @classmethod
    def from_dict(cls, d: dict) -> "SimulationScene":
        """Reconstruct a SimulationScene from the dict produced by `save`/`to_json`
        (i.e. the parsed `{"model": ..., "states": ...}` document).

        Binary `__b64__`-encoded fields inside `states` (e.g. from
        ``add_trajectory(binary=True)``) are left as-is, matching the on-disk
        wire format, so a subsequent `save()` reproduces the same bytes for
        those fields without a decode/re-encode round trip.

        Accepts either `states` layout (see :mod:`simview.columnar`). A
        columnar document is expanded back into the per-frame list `states`
        is in memory, so every authoring API keeps working unchanged; the
        expansion is exact, so re-saving columnar reproduces the same blobs.
        """
        try:
            model_dict = d["model"]
            states = d["states"]
        except KeyError as e:
            raise ValueError(f"Scene dict is missing required key: {e}") from e

        model = SimViewModel.from_dict(model_dict)
        if is_columnar(states):
            states = expand_columnar_states(states, model.batch_size)
        scene = cls(
            batch_size=model.batch_size,
            scalar_names=model.scalar_names,
            dt=model.dt,
            collapse=model.collapse,
            terrain=model.terrain,
            bodies=model.bodies,
            static_objects=model.static_objects,
            batch_names=model.batch_names,
            metadata=model.metadata,
            episodes=model.episodes,
            viewer_defaults=model.viewer_defaults,
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
        B = self.model.batch_size
        for state in body_states:
            _validate_body_name(state.body_name, self.model)
            _validate_not_rigid(state.body_name, self.model)
            label = _name_label(state.body_name)
            if state.batch_rows != B:
                raise ValueError(
                    f"{label}: position/orientation have {state.batch_rows} "
                    f"batch row(s); expected {B} (the model's batch_size)."
                )
            for attr, value in state.optional_attrs.items():
                rows = len(value) if attr == "contacts" else _batch_rows(value)
                if rows != B:
                    raise ValueError(
                        f"{label}.{attr} has {rows} batch row(s); expected {B}."
                    )

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
                    # A 0-dim tensor/array yields a bare float from .tolist().
                    # Wrap it so every scalar is stored as a per-batch list --
                    # consumers (merge's values.extend, the viewer's plots)
                    # would otherwise choke on the odd frame out.
                    as_list = v.tolist()
                    processed_scalars[k] = (
                        as_list if isinstance(as_list, list) else [as_list]
                    )
                elif isinstance(v, list):
                    processed_scalars[k] = v
                else:
                    raise TypeError(
                        f"Scalar value for '{k}' must be a torch.Tensor, "
                        "numpy.ndarray, or a list."
                    )
                if len(processed_scalars[k]) != B:
                    raise ValueError(
                        f"Scalar '{k}' has {len(processed_scalars[k])} value(s); "
                        f"expected one per batch ({B})."
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
        times: torch.Tensor | np.ndarray | Sequence[float],
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

        contacts_by_name = {
            body_key(name): contacts for name, contacts in prepared_contacts
        }
        for t in range(T):
            bodies = [
                {
                    "name": name,
                    **{key: encode(arr[t]) for key, arr in fields.items()},
                    **(
                        {"contacts": contacts_by_name[body_key(name)][t]}
                        if body_key(name) in contacts_by_name
                        else {}
                    ),
                }
                for name, fields in prepared
            ]
            state = {"time": times[t], "bodies": bodies}
            for name, arr in scalars.items():
                state[name] = arr[t].tolist()
            self.states.append(state)

    def _check_episodes_in_range(self) -> None:
        """Every episode must start at a frame this scene actually has."""
        for episode in self.model.episodes or []:
            if episode.start_index >= len(self.states):
                raise ValueError(
                    f"Episode starts at frame {episode.start_index} but the scene "
                    f"has only {len(self.states)} state(s)."
                )

    def reconcile_available_attributes(self) -> None:
        """Set each body's `available_attributes` to the optional attributes
        its states actually carry (an attribute may be absent from earlier
        frames but present later). The viewer only builds contact markers and
        vector arrows for declared attributes, so `save()` and `show()` both
        call this before serializing the model. Unknown per-body keys (e.g.
        from a hand-edited file) are ignored with a warning.
        """
        if not self.states:
            return
        known = {attr.value for attr in OptionalBodyStateAttribute}
        provided_by_body: dict[str, set[str]] = {}
        warned: set[str] = set()
        for state in self.states:
            for body_data in state.get("bodies", []):
                name = body_data.get("name")
                if not name:
                    continue
                keys = set(body_data) - {"name", "bodyTransform"}
                for unknown in keys - known - warned:
                    warned.add(unknown)
                    logger.warning(
                        "Ignoring unknown per-body state field '%s' on '%s'.",
                        unknown,
                        _name_label(name),
                    )
                for n in iter_names(name):
                    provided_by_body.setdefault(n, set()).update(keys & known)

        for name, body in self.model.bodies.items():
            if name in provided_by_body:
                # Enum declaration order, so the written list is deterministic
                # across processes (a set's order is hash-seed dependent).
                attrs = [
                    attr
                    for attr in OptionalBodyStateAttribute
                    if attr.value in provided_by_body[name]
                ]
                body.available_attributes = attrs or None

    def save(
        self,
        filepath: str | Path,
        compress: bool = False,
        columnar: bool | None = None,
    ) -> None:
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
            columnar: Which `states` layout to write (see
                :mod:`simview.columnar`). ``None`` (the default) writes the
                columnar layout when the states allow it and silently falls
                back to the legacy per-frame array when they don't. ``True``
                requires it, raising ValueError rather than falling back --
                useful in a pipeline that depends on the smaller output.
                ``False`` always writes the legacy array.

        The columnar layout stores one whole-trajectory binary blob per body
        per field instead of thousands of small per-frame ones, which makes
        both the file and the viewer's load of it dramatically cheaper. Both
        layouts are read transparently by `load`, `merge_simulation_files`,
        the viewer and the CLI tools.
        """
        if not self.model.is_complete:
            raise ValueError(
                "Cannot save data: The simulation model is not complete (e.g., terrain might be missing)."
            )
        self._check_episodes_in_range()
        self.reconcile_available_attributes()

        output_path = Path(filepath)
        if compress and output_path.suffix != ".gz":
            output_path = output_path.with_name(output_path.name + ".gz")
        compress = compress or output_path.suffix == ".gz"
        output_path.parent.mkdir(parents=True, exist_ok=True)

        model_json = self.model.to_json()
        columnar_states = None
        if columnar is not False and self.states:
            columnar_states = columnarize_states(self.states, model_json, inline_blob)
            if columnar_states is None and columnar is True:
                raise ValueError(
                    "columnar=True but these states cannot be packed columnar "
                    "(they are not uniform across frames -- see the warning "
                    "logged above for the specific reason). Pass columnar=None "
                    "to fall back to the legacy per-frame layout automatically."
                )

        logger.info("Saving simulation data to %s...", output_path)
        with (gzip.open if compress else open)(output_path, "wt") as f:
            f.write("{\n")
            f.write('  "model": ')
            json.dump(model_json, f, indent=2)
            f.write(",\n")
            if columnar_states is not None:
                f.write('  "states": ')
                json.dump(columnar_states, f)
                f.write("\n}")
            else:
                # Streamed frame by frame: the per-frame layout is only
                # reached for scenes too irregular to columnarize, which are
                # exactly the large ones worth not materializing at once.
                f.write('  "states": [\n')
                for i, state in enumerate(self.states):
                    if i > 0:
                        f.write(",\n")
                    f.write("    ")
                    json.dump(state, f)
                f.write("\n  ]\n}")
        logger.info("Simulation data successfully saved to %s", output_path)

    def save_static(self, directory: str | Path) -> None:
        """Write a static bundle (`model.json`, `states.json`, `blob/<id>`)
        that the viewer's static mode (`#data=<base url>`, see
        `simview.view_hash`) can load from any plain static file server.

        Uses the same columnar layout and fallback as `save`.
        """
        # Reuse save() (attribute reconciliation, columnar fallback) via a
        # temp file rather than duplicating it; ponytail: extra JSON roundtrip.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "scene.json"
            self.save(path)
            write_static_bundle(json.loads(path.read_text()), directory)

    def show(
        self,
        host: str = "127.0.0.1",
        preferred_port: int = 5420,
        open_browser: bool = False,
        view: str | None = None,
        height: int = 600,
    ) -> ViewerHandle:
        """Serve a snapshot of this scene on a background thread and return
        immediately, instead of blocking like `SimViewLauncher`/`SimViewServer.run`.

        Intended for Jupyter notebooks and scripts that want to keep running
        (or keep the cell interactive) while the viewer is up: the returned
        `ViewerHandle` renders inline via `_repr_html_` when it's a cell's
        result, and its `stop()` (or exiting it as a context manager) shuts
        the server down. The scene itself is left untouched -- unlike
        `SimViewLauncher`, `show` doesn't clear `self.states`/`self.model`, so
        the same scene can still be `save()`d or shown again afterwards.

        Multiple concurrent `show()` calls (on the same or different scenes)
        are fine -- each gets its own server thread and port (via
        `find_free_port`).

        `view` is a view-link fragment (see `simview.view_hash`) the inline
        iframe opens with, e.g. a fixed camera or `ui=False`; `height` is the
        iframe height in pixels.
        """
        if not self.model.is_complete:
            raise ValueError(
                "Cannot show scene: the simulation model is not complete "
                "(e.g. terrain might be missing)."
            )
        self._check_episodes_in_range()
        self.reconcile_available_attributes()

        data = {"model": self.model.to_json(), "states": self.states}
        handle = ViewerHandle(
            SimViewServer(data=data).app,
            host=host,
            preferred_port=preferred_port,
            thread_name="simview-show-server",
            view=view,
            iframe_height=height,
        )

        logger.info("SimView viewer running on %s", handle.url)
        if open_browser:
            import webbrowser

            webbrowser.open(handle.url)

        return handle

    def create_terrain(
        self,
        heightmap: torch.Tensor,
        normals: torch.Tensor | None = None,
        x_lim: tuple[float, float] | None = None,
        y_lim: tuple[float, float] | None = None,
        grid_res: float | None = None,
        properties: dict[str, torch.Tensor] | None = None,
        property_bounds: dict[str, tuple[float, float]] | None = None,
        embedding_map: torch.Tensor | None = None,
    ) -> None:
        """Adds terrain to the simulation model.

        Args:
            heightmap (torch.Tensor): 2D or 3D tensor of terrain heights.
            normals (torch.Tensor | None): 3D or 4D tensor of terrain normals. If None,
                normals are automatically computed from the heightmap gradients.
            x_lim (tuple[float, float] | None): (min, max) coordinates for the X axis.
            y_lim (tuple[float, float] | None): (min, max) coordinates for the Y axis.
            grid_res (float | None): Spacing between adjacent grid nodes. If x_lim
                and y_lim are omitted they are inferred so the nodes sit `grid_res`
                apart, centered at 0 (a W-wide grid spans `(W - 1) * grid_res`).
            properties (dict[str, torch.Tensor] | None): Optional arbitrary named
                per-cell scalar maps (2D or 3D, like `heightmap`), e.g.
                `{"friction": friction_map, "stiffness": stiffness_map}`. Each becomes
                selectable as a terrain color mode in the viewer automatically, with no
                further code changes needed.
            property_bounds (dict[str, tuple[float, float]] | None): Optional explicit
                `(min, max)` color-scale range per property name, e.g.
                `{"friction": (0.0, 1.0)}`. Each name must also appear in
                `properties`; names left out keep the default, which is that map's
                own data range. Use this to keep one scale comparable across scenes
                -- cells outside the range saturate at the end colors rather than
                being hidden.
            embedding_map (torch.Tensor | None): Optional per-cell K-wide feature map
                (3D channels-first `(K, Dy, Dx)` or 4D `(B, K, Dy, Dx)`, like `normals`)
                enabling the viewer's click-to-similarity "features" color mode.
        """
        batch_size = self.model.batch_size
        if heightmap.ndim == 2:
            heightmap = heightmap.unsqueeze(0)  # add batch dim

        if x_lim is None or y_lim is None:
            if grid_res is None:
                raise ValueError("Must provide either (x_lim, y_lim) or grid_res")
            H_dim, W_dim = heightmap.shape[-2:]
            half_x, half_y = (W_dim - 1) * grid_res / 2.0, (H_dim - 1) * grid_res / 2.0
            x_lim = x_lim or (-half_x, half_x)
            y_lim = y_lim or (-half_y, half_y)

        if normals is None:
            # The W nodes span the full extent (viewer, terrain.py), so the
            # node spacing is extent / (W - 1), not extent / W.
            H_dim, W_dim = heightmap.shape[-2:]
            res_x = (x_lim[1] - x_lim[0]) / max(W_dim - 1, 1)
            res_y = (y_lim[1] - y_lim[0]) / max(H_dim - 1, 1)
            dzdy, dzdx = torch.gradient(heightmap, spacing=(res_y, res_x), dim=(-2, -1))
            nx = -dzdx
            ny = -dzdy
            nz = torch.ones_like(nx)
            computed_normals = torch.stack([nx, ny, nz], dim=-3)
            computed_normals = computed_normals / torch.linalg.norm(
                computed_normals, dim=-3, keepdim=True
            )
            normals = cast(torch.Tensor, computed_normals.to(dtype=heightmap.dtype))

        if normals.ndim == 3:  # channels first
            normals = normals.unsqueeze(0)  # add batch dim
        properties = {
            name: (prop.unsqueeze(0) if prop.ndim == 2 else prop)
            for name, prop in (properties or {}).items()
        }
        if embedding_map is not None and embedding_map.ndim == 3:  # channels first
            embedding_map = embedding_map.unsqueeze(0)

        # Each field's batch dim must be either 1 (shared across all batches) or
        # exactly batch_size (per-batch). Anything else is a mistake, and the old
        # code silently mishandled the mixed case (e.g. shared height + per-batch
        # normals), producing an inconsistent isSingleton flag.
        provided = {
            "heightmap": heightmap,
            "normals": normals,
            "embedding_map": embedding_map,
            **properties,
        }
        for name, tensor in provided.items():
            if tensor is not None and tensor.shape[0] not in (1, batch_size):
                raise ValueError(
                    f"Terrain '{name}' batch dim ({tensor.shape[0]}) must be 1 "
                    f"(shared) or {batch_size} (per-batch)."
                )

        # Singleton only when every provided field is shared and there is more than
        # one batch to share it across.
        is_singleton = batch_size > 1 and all(
            tensor.shape[0] == 1 for tensor in provided.values() if tensor is not None
        )

        # A fully-shared (singleton) terrain ships exactly one copy of every
        # field -- the viewer, merge, and `simview terrain` all detect the
        # shared row by its length (resolution-sized instead of
        # batch_size * resolution). Only the mixed case (some fields shared,
        # some per-batch) broadcasts the shared ones, since a non-singleton
        # terrain's fields must all be batch_size rows.
        if batch_size > 1 and not is_singleton:
            if heightmap.shape[0] == 1:
                heightmap = heightmap.repeat(batch_size, 1, 1)
            if normals.shape[0] == 1:
                normals = normals.repeat(batch_size, 1, 1, 1)
            properties = {
                name: (prop.repeat(batch_size, 1, 1) if prop.shape[0] == 1 else prop)
                for name, prop in properties.items()
            }
            if embedding_map is not None and embedding_map.shape[0] == 1:
                embedding_map = embedding_map.repeat(batch_size, 1, 1, 1)

        self.model.terrain = SimViewTerrain.create(
            heightmap=heightmap,
            normals=normals,
            x_lim=x_lim,
            y_lim=y_lim,
            is_singleton=is_singleton,
            properties=properties,
            property_bounds=property_bounds,
            embedding_map=embedding_map,
        )

    def create_pointcloud(
        self,
        body_name: str,
        points: torch.Tensor,
        color: torch.Tensor | None = None,
        embedding: torch.Tensor | None = None,
        **kwargs,
    ) -> None:
        """Creates and adds a pointcloud body to the simulation model.

        Args:
            body_name (str): Unique name for this body.
            points (torch.Tensor): (N, 3) point positions.
            color (torch.Tensor | None): Optional (N, 3) per-point RGB in [0, 1]
                for static vertex-colored rendering.
            embedding (torch.Tensor | None): Optional (N, K) per-point feature
                vector (e.g. a reduced-dim PCA projection) enabling the
                viewer's click-to-similarity color mode.
        """
        self.model.add_body(
            SimViewBody.create_pointcloud(
                body_name, points, color=color, embedding=embedding, **kwargs
            )
        )

    def create_body(
        self,
        body_name: str,
        shape_type: BodyShapeType,
        available_attributes: list[OptionalBodyStateAttribute | str] | None = None,
        parent: str | None = None,
        local_transform: LocalTransformLike | None = None,
        color: Sequence[float] | None = None,
        opacity: float | None = None,
        visible: bool = True,
        **kwargs,
    ) -> None:
        """Creates and adds a dynamic body to the simulation model.

        ``color`` (RGB in [0, 1]) and ``opacity`` (in (0, 1]) style the
        mesh/primitive representation (box/sphere/cylinder/mesh); a point
        cloud's per-point colour is its shape's own ``color``. ``visible=False``
        hides the body initially.

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
        self.model.add_body(
            SimViewBody.create(
                body_name,
                shape_type,
                available_attributes=available_attributes,
                parent=parent,
                local_transform=local_transform,
                color=color,
                opacity=opacity,
                visible=visible,
                **kwargs,
            )
        )

    def _clear_internal_data(self) -> None:
        """
        Clears the stored simulation states and model data to free up memory.
        """
        self.states = []
        # Clear large terrain data if present
        if self.model and self.model.terrain:
            self.model.terrain.height_data = []
            self.model.terrain.normals = []
            self.model.terrain.properties = {}
            self.model.terrain.embedding_data = None
        logger.info("SimulationScene: Internal data cleared.")
