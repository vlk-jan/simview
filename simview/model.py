import json
import logging
import math
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

import torch

from simview.columnar import inline_blob

logger = logging.getLogger("simview.model")


def _encode_blob(array) -> str:
    """Encode a numpy array as an inline little-endian float32 `__b64__` blob."""
    return inline_blob(array.astype("<f4").tobytes())


def _validated_property_bounds(name: str, bounds: Any) -> tuple[float, float]:
    """Validate one explicit `(min, max)` color-scale range for a terrain property.

    The viewer only honors a range when both ends are finite numbers spanning a
    non-zero interval; anything else silently falls back to clamping the raw
    value into [0, 1] (see `#normalizeToRange` in `static/js/objects/Terrain.js`),
    which looks like a working scale but isn't. Reject it here instead.
    """
    try:
        low, high = bounds
    except (TypeError, ValueError):
        raise ValueError(
            f"Bounds for terrain property '{name}' must be a (min, max) pair; "
            f"got {bounds!r}."
        ) from None
    try:
        low, high = float(low), float(high)
    except (TypeError, ValueError):
        raise ValueError(
            f"Bounds for terrain property '{name}' must be numbers; got {bounds!r}."
        ) from None
    if not (math.isfinite(low) and math.isfinite(high)):
        raise ValueError(
            f"Bounds for terrain property '{name}' must be finite; got ({low}, {high})."
        )
    if low >= high:
        raise ValueError(
            f"Bounds for terrain property '{name}' must satisfy min < max; "
            f"got ({low}, {high})."
        )
    return low, high


class BodyShapeType(StrEnum):
    POINTCLOUD = "pointcloud"
    MESH = "mesh"
    BOX = "box"
    SPHERE = "sphere"
    CYLINDER = "cylinder"


class OptionalBodyStateAttribute(StrEnum):
    CONTACTS = "contacts"
    VELOCITY = "velocity"
    ANGULAR_VELOCITY = "angularVelocity"
    FORCE = "force"
    TORQUE = "torque"


# Primitive shape parameters that must be present and strictly positive.
_REQUIRED_POSITIVE_SHAPE_PARAMS = {
    BodyShapeType.BOX: ("hx", "hy", "hz"),
    BodyShapeType.SPHERE: ("radius",),
    BodyShapeType.CYLINDER: ("radius", "height"),
}


@dataclass
class TerrainProperty:
    """One arbitrary named per-cell scalar field over the terrain grid (e.g.
    friction, stiffness, or any other user-defined property), stored the same
    way as `SimViewTerrain.height_data` -- a plain nested list, or an opaque
    `__b64__`-prefixed blob string for compactness."""

    data: list[list[float]] | str
    # Value range used by the viewer to normalize the color map (analogous to
    # min_z/max_z for height). None when not computed.
    min: float | None = None
    max: float | None = None

    def to_json(self):
        return {"data": self.data, "min": self.min, "max": self.max}

    @classmethod
    def from_dict(cls, d: dict) -> "TerrainProperty":
        return cls(data=d["data"], min=d.get("min"), max=d.get("max"))


@dataclass
class SimViewTerrain:
    extent_x: float
    extent_y: float
    shape_x: int
    shape_y: int
    min_x: float
    min_y: float
    max_x: float
    max_y: float
    min_z: float
    max_z: float
    # These are plain nested lists when constructed directly, but `create()` (and
    # deserialization from JSON) may instead store an opaque `__b64__`-prefixed
    # base64 blob string for compactness; `to_json`/`from_dict` pass them through
    # as-is either way.
    height_data: list[list[float]] | str
    normals: list[list[list[float]]] | str
    is_singleton: bool
    # Arbitrary named per-cell scalar fields (e.g. "friction", "stiffness", or
    # any other user-defined property), keyed by name -- see `TerrainProperty`.
    # Adding a new property never requires touching this class or the viewer:
    # supply it by name in `create()`'s `properties` dict and it becomes
    # selectable as a terrain color mode automatically.
    properties: dict[str, TerrainProperty] = field(default_factory=dict)
    # Per-cell K-wide feature vector (e.g. a reduced-dim PCA projection of a
    # learned backbone's features), stored the same way as `normals` (width
    # inferred client-side from flat length, not shipped explicitly). Used by
    # the viewer's "features" color mode: cosine similarity to a clicked cell,
    # computed entirely in-browser -- not a named scalar property, so it has
    # no min/max bounds (similarity is always [-1, 1]) and isn't part of
    # `properties`.
    embedding_data: list[list[float]] | str | None = None

    def to_json(self):
        return {
            "dimensions": {
                "sizeX": self.extent_x,
                "sizeY": self.extent_y,
                "resolutionX": self.shape_x,
                "resolutionY": self.shape_y,
            },
            "bounds": {
                "minX": self.min_x,
                "minY": self.min_y,
                "maxX": self.max_x,
                "maxY": self.max_y,
                "minZ": self.min_z,
                "maxZ": self.max_z,
            },
            "heightData": self.height_data,
            "normals": self.normals,
            "isSingleton": self.is_singleton,
            "properties": {
                name: prop.to_json() for name, prop in self.properties.items()
            },
            "embeddingData": self.embedding_data,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "SimViewTerrain":
        """Reconstruct a SimViewTerrain from the dict produced by `to_json`.

        `heightData`/`normals`/each property's `data` are kept in whatever
        form they were serialized in (plain nested lists or a `__b64__` blob
        string) -- decode with `simview.columnar.blob_floats` if you need the
        flat float values back out.
        """
        try:
            dimensions = d["dimensions"]
            bounds = d["bounds"]
            height_data = d["heightData"]
            normals = d["normals"]
            is_singleton = d["isSingleton"]
        except KeyError as e:
            raise ValueError(f"Terrain dict is missing required key: {e}") from e

        properties = {
            name: TerrainProperty.from_dict(p)
            for name, p in (d.get("properties") or {}).items()
        }

        return cls(
            extent_x=dimensions["sizeX"],
            extent_y=dimensions["sizeY"],
            shape_x=dimensions["resolutionX"],
            shape_y=dimensions["resolutionY"],
            min_x=bounds["minX"],
            min_y=bounds["minY"],
            max_x=bounds["maxX"],
            max_y=bounds["maxY"],
            min_z=bounds["minZ"],
            max_z=bounds["maxZ"],
            height_data=height_data,
            normals=normals,
            is_singleton=is_singleton,
            properties=properties,
            embedding_data=d.get("embeddingData"),
        )

    @staticmethod
    def create(
        heightmap: torch.Tensor,  # ! remember the x,y indexing is assumed to follow torch's "xy" convention, so increasing column index is increasing x coordinate
        normals: torch.Tensor,
        x_lim: tuple[float, float],
        y_lim: tuple[float, float],
        is_singleton: bool,
        properties: dict[str, torch.Tensor] | None = None,
        property_bounds: dict[str, tuple[float, float]] | None = None,
        embedding_map: torch.Tensor | None = None,
    ) -> "SimViewTerrain":
        if heightmap.ndim != 3:
            raise ValueError(
                f"Heightmap must include a batch dimension (ndim=3); got ndim={heightmap.ndim}."
            )
        if normals.ndim != 4:
            raise ValueError(
                f"Normals must include a batch dimension (ndim=4); got ndim={normals.ndim}."
            )
        if normals.shape[1] != 3:
            raise ValueError(
                f"Normals must have 3 channels (shape[1] == 3); got shape={tuple(normals.shape)}."
            )
        B, Dy, Dx = heightmap.shape
        grids = {
            "normals": tuple(normals.shape[2:]),
            **{
                f"property '{name}'": tuple(p.shape[1:])
                for name, p in (properties or {}).items()
                if p.ndim == 3  # wrong ndim is reported below
            },
        }
        if embedding_map is not None and embedding_map.ndim == 4:
            grids["embedding_map"] = tuple(embedding_map.shape[2:])
        for label, grid in grids.items():
            if grid != (Dy, Dx):
                raise ValueError(
                    f"Terrain {label} grid {grid} does not match the heightmap "
                    f"grid {(Dy, Dx)}."
                )
        min_x, max_x = x_lim
        min_y, max_y = y_lim
        min_z = heightmap.min().item()
        max_z = heightmap.max().item()
        extent_x = max_x - min_x
        extent_y = max_y - min_y
        height_data_list = _encode_blob(heightmap.flatten(1).cpu().numpy())
        normals_list = _encode_blob(
            normals.permute(0, 2, 3, 1).flatten(1, 2).cpu().numpy()
        )

        property_bounds = property_bounds or {}
        unknown_bounds = set(property_bounds) - set(properties or {})
        if unknown_bounds:
            raise ValueError(
                f"property_bounds names {sorted(unknown_bounds)} have no matching "
                f"entry in `properties` (got {sorted(properties or {})})."
            )

        properties_out: dict[str, TerrainProperty] = {}
        for name, prop_map in (properties or {}).items():
            if prop_map.ndim != 3:
                raise ValueError(
                    f"Property '{name}' map must include a batch dimension "
                    f"(ndim=3); got ndim={prop_map.ndim}."
                )
            # Explicit bounds pin the viewer's color scale (e.g. a fixed [0, 1]
            # friction scale comparable across scenes, at the cost of saturating
            # out-of-range cells); otherwise it's the map's own data range.
            if name in property_bounds:
                low, high = _validated_property_bounds(name, property_bounds[name])
            else:
                low, high = prop_map.min().item(), prop_map.max().item()
            properties_out[name] = TerrainProperty(
                data=_encode_blob(prop_map.flatten(1).cpu().numpy()),
                min=low,
                max=high,
            )

        embedding_data_list = None
        if embedding_map is not None:
            if embedding_map.ndim != 4:
                raise ValueError(
                    f"Embedding map must include a batch dimension (ndim=4); got ndim={embedding_map.ndim}."
                )
            embedding_data_list = _encode_blob(
                embedding_map.permute(0, 2, 3, 1).flatten(1, 2).cpu().numpy()
            )

        return SimViewTerrain(
            extent_x=extent_x,
            extent_y=extent_y,
            shape_x=Dx,
            shape_y=Dy,
            min_x=min_x,
            min_y=min_y,
            max_x=max_x,
            max_y=max_y,
            min_z=min_z,
            max_z=max_z,
            height_data=height_data_list,
            normals=normals_list,
            is_singleton=is_singleton,
            properties=properties_out,
            embedding_data=embedding_data_list,
        )


@dataclass
class SimViewBody:
    name: str
    shape: dict
    available_attributes: list[OptionalBodyStateAttribute] | None = None
    # `parent`/`local_transform` express this body's pose relative to another
    # body instead of world space. `local_transform` (a constant [x,y,z,w,qx,qy,qz]
    # offset) marks a *rigid* attachment (e.g. a wheel bolted to a chassis): this
    # body never appears in any state's `bodies[]`, and its world pose is derived
    # every frame from the parent's current pose plus this fixed offset. An
    # *articulated* attachment (e.g. an arm joint) instead sets only `parent` and
    # keeps supplying a per-frame `bodyTransform` in states as usual -- it's just
    # interpreted as local to the parent's current-frame pose rather than world.
    parent: str | None = None
    local_transform: list[float] | None = None
    # Per-body look of the mesh/primitive representation (box/sphere/cylinder/
    # mesh). `color` is an RGB triple in [0, 1]; `opacity` in (0, 1] (None =
    # opaque); `visible=False` hides the whole body until the user shows it.
    color: list[float] | None = None
    opacity: float | None = None
    visible: bool = True

    def __post_init__(self):
        if self.color is not None:
            if len(self.color) != 3 or not all(0.0 <= c <= 1.0 for c in self.color):
                raise ValueError(
                    f"Body '{self.name}' color must be an RGB triple of floats "
                    f"in [0, 1]; got {self.color!r}."
                )
        if self.opacity is not None and not 0.0 < self.opacity <= 1.0:
            raise ValueError(
                f"Body '{self.name}' opacity must be in (0, 1]; got {self.opacity!r}."
            )
        if self.local_transform is not None:
            if self.parent is None:
                raise ValueError(
                    f"Body '{self.name}' has local_transform but no parent; "
                    "local_transform only makes sense relative to a parent body."
                )
            if len(self.local_transform) != 7:
                raise ValueError(
                    f"Body '{self.name}' local_transform must have 7 elements "
                    f"([x, y, z, w, qx, qy, qz]); got {len(self.local_transform)}."
                )

    def set_available_attributes(
        self, available_attributes: list[str | OptionalBodyStateAttribute]
    ) -> None:
        if self.available_attributes is not None:
            raise ValueError("Available attributes already set")
        self.available_attributes = [
            v
            if isinstance(v, OptionalBodyStateAttribute)
            else OptionalBodyStateAttribute(v)
            for v in available_attributes
        ]

    @staticmethod
    def _create_shape_dict(body_type: BodyShapeType, **kwargs) -> dict:
        """Helper to create the shape dictionary, converting tensors."""
        shape_dict: dict[str, Any] = {"type": body_type.value}
        for key, value in kwargs.items():
            if isinstance(value, torch.Tensor):
                if value.numel() > 1:
                    shape_dict[key] = _encode_blob(value.cpu().numpy())
                else:
                    shape_dict[key] = value.item()
            else:
                shape_dict[key] = value
        for key in _REQUIRED_POSITIVE_SHAPE_PARAMS.get(body_type, ()):
            value = shape_dict.get(key)
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or value <= 0
            ):
                raise ValueError(
                    f"{body_type.value} shape requires {key} to be a positive "
                    f"number; got {value!r}."
                )
        return shape_dict

    @staticmethod
    def create(
        name: str,
        body_type: BodyShapeType,
        available_attributes: list[OptionalBodyStateAttribute | str] | None = None,
        parent: str | None = None,
        local_transform: Any | None = None,
        color: Any | None = None,
        opacity: float | None = None,
        visible: bool = True,
        **kwargs,
    ) -> "SimViewBody":
        shape_dict = SimViewBody._create_shape_dict(body_type, **kwargs)
        if local_transform is not None and hasattr(local_transform, "tolist"):
            local_transform = local_transform.tolist()
        body = SimViewBody(
            name=name,
            shape=shape_dict,
            parent=parent,
            local_transform=list(local_transform)
            if local_transform is not None
            else None,
            color=[float(c) for c in color] if color is not None else None,
            opacity=opacity,
            visible=visible,
        )
        if available_attributes is not None:
            body.set_available_attributes(available_attributes)
        return body

    @staticmethod
    def create_box(
        name: str, hx: float, hy: float, hz: float, **kwargs
    ) -> "SimViewBody":
        return SimViewBody.create(
            name, BodyShapeType.BOX, hx=hx, hy=hy, hz=hz, **kwargs
        )

    @staticmethod
    def create_pointcloud(
        name: str,
        points: torch.Tensor,
        color: torch.Tensor | None = None,
        embedding: torch.Tensor | None = None,
        **kwargs,
    ) -> "SimViewBody":
        """`color` (N, 3) in [0, 1] is an optional static per-point RGB color,
        used by the viewer for vertex-colored rendering. `embedding` (N, K) is
        an optional per-point K-wide feature vector (e.g. a reduced-dim PCA
        projection of a learned backbone's features) enabling the viewer's
        click-to-similarity color mode: cosine similarity to a clicked point,
        computed entirely in-browser from this data. Both round-trip through
        the existing generic `__b64__` blob mechanism -- no new wire format."""
        if points.ndim != 2 or points.shape[1] != 3:
            raise ValueError(
                f"points must have shape (N, 3); got {tuple(points.shape)}."
            )
        N = points.shape[0]
        shape_extra: dict[str, Any] = {}
        if color is not None:
            if tuple(color.shape) != (N, 3):
                raise ValueError(
                    f"color must have shape ({N}, 3) matching points; got {tuple(color.shape)}."
                )
            shape_extra["color"] = color
        if embedding is not None:
            if embedding.ndim != 2 or embedding.shape[0] != N:
                raise ValueError(
                    f"embedding must have shape ({N}, K) matching points; got {tuple(embedding.shape)}."
                )
            shape_extra["embedding"] = embedding
        # Per-point `color` lives in the shape, so it can't go through
        # `create`'s kwargs (where `color` is the body-level tint).
        body = SimViewBody.create(
            name, BodyShapeType.POINTCLOUD, points=points, **kwargs
        )
        body.shape.update(
            SimViewBody._create_shape_dict(BodyShapeType.POINTCLOUD, **shape_extra)
        )
        return body

    @staticmethod
    def create_mesh(
        name: str, vertices: torch.Tensor, faces: torch.Tensor, **kwargs
    ) -> "SimViewBody":
        return SimViewBody.create(
            name, BodyShapeType.MESH, vertices=vertices, faces=faces, **kwargs
        )

    def to_json(self) -> dict:
        r = {"name": self.name, "shape": self.shape}
        if self.available_attributes is not None:
            r["availableAttributes"] = [v.value for v in self.available_attributes]
        if self.parent is not None:
            r["parent"] = self.parent
        if self.local_transform is not None:
            r["localTransform"] = self.local_transform
        if self.color is not None:
            r["color"] = self.color
        if self.opacity is not None:
            r["opacity"] = self.opacity
        if not self.visible:
            r["visible"] = False
        return r

    @classmethod
    def from_dict(cls, d: dict) -> "SimViewBody":
        """Reconstruct a SimViewBody from the dict produced by `to_json`."""
        try:
            name = d["name"]
            shape = d["shape"]
        except KeyError as e:
            raise ValueError(f"Body dict is missing required key: {e}") from e
        available_attributes = d.get("availableAttributes")
        return cls(
            name=name,
            shape=shape,
            available_attributes=[
                OptionalBodyStateAttribute(v) for v in available_attributes
            ]
            if available_attributes is not None
            else None,
            parent=d.get("parent"),
            local_transform=d.get("localTransform"),
            color=d.get("color"),
            opacity=d.get("opacity"),
            visible=d.get("visible", True),
        )


@dataclass
class SimViewStaticObject:
    name: str
    is_singleton: bool
    shape: dict | None = None  # Used if is_singleton is True
    shapes: list[dict] | None = None  # Used if is_singleton is False

    def __post_init__(self):
        if (self.shape is not None) != self.is_singleton:
            raise ValueError(
                "A singleton static object needs 'shape'; a batched one must not."
            )
        if (self.shapes is not None) == self.is_singleton:
            raise ValueError(
                "A batched static object needs 'shapes'; a singleton one must not."
            )

    @staticmethod
    def create_singleton(
        name: str, shape_type: BodyShapeType, **kwargs
    ) -> "SimViewStaticObject":
        shape_dict = SimViewBody._create_shape_dict(
            shape_type, **kwargs
        )  # Reuse helper
        return SimViewStaticObject(name=name, is_singleton=True, shape=shape_dict)

    @staticmethod
    def create_batched(
        name: str, shape_type: BodyShapeType, shapes_kwargs: list[dict[str, Any]]
    ) -> "SimViewStaticObject":
        """
        Creates a batched static object where all instances share the same shape type.

        Args:
            name: The name of the static object group.
            shape_type: The BodyShapeType common to all instances in the batch.
            shapes_kwargs: A list of dictionaries, where each dictionary contains the
                           keyword arguments for creating the shape of one instance
                           in the batch (e.g., [{'hx': 0.1, 'hy': 0.1, 'hz': 0.1}, {'hx': 0.2, ...}]).
                           The length of this list must match the batch size.
        """
        shapes_list = []
        if not shapes_kwargs:
            raise ValueError("Batched shapes kwargs list cannot be empty.")
        # The check for list length matching batch_size happens in SimViewModel.add_static_object
        for kwargs in shapes_kwargs:
            # Ensure 'type' isn't passed within kwargs, as it's defined by shape_type
            if "type" in kwargs:
                raise ValueError(
                    "Do not include 'type' in shapes_kwargs; use the shape_type argument."
                )
            shapes_list.append(
                SimViewBody._create_shape_dict(shape_type, **kwargs)
            )  # Reuse helper
        return SimViewStaticObject(name=name, is_singleton=False, shapes=shapes_list)

    def to_json(self) -> dict:
        r = {"name": self.name, "isSingleton": self.is_singleton}
        if self.is_singleton:
            r["shape"] = self.shape
        else:
            r["shapes"] = self.shapes
        return r

    @classmethod
    def from_dict(cls, d: dict) -> "SimViewStaticObject":
        """Reconstruct a SimViewStaticObject from the dict produced by `to_json`."""
        try:
            name = d["name"]
            is_singleton = d["isSingleton"]
        except KeyError as e:
            raise ValueError(f"Static object dict is missing required key: {e}") from e
        return cls(
            name=name,
            is_singleton=is_singleton,
            shape=d.get("shape"),
            shapes=d.get("shapes"),
        )


@dataclass
class SimViewEpisode:
    """One episode boundary in an otherwise continuous timeline.

    RL runs are episodic: the states array is one long recording, but it is
    really a sequence of resets. An episode marks the frame a run *starts* at,
    so `episodes` is a list of starts and each episode implicitly ends where
    the next one begins (the last runs to the end of the states).

    Purely descriptive metadata -- the viewer uses it to draw boundaries on the
    playback bar, offer next/previous-episode navigation, and aggregate scalars
    per episode. Nothing about playback itself changes.
    """

    start_index: int
    label: str | None = None

    def __post_init__(self):
        if not isinstance(self.start_index, int) or isinstance(self.start_index, bool):
            raise ValueError(
                f"Episode start_index must be an int, got {type(self.start_index).__name__}"
            )
        if self.start_index < 0:
            raise ValueError(
                f"Episode start_index must be >= 0, got {self.start_index}"
            )

    def to_json(self) -> dict:
        r: dict = {"startIndex": self.start_index}
        if self.label is not None:
            r["label"] = self.label
        return r

    @classmethod
    def from_dict(cls, d: dict) -> "SimViewEpisode":
        try:
            start_index = d["startIndex"]
        except (KeyError, TypeError) as e:
            raise ValueError(f"Episode dict is missing required key: {e}") from e
        return cls(start_index=int(start_index), label=d.get("label"))


def _validate_episodes(episodes: list[SimViewEpisode] | None) -> None:
    """Episode starts must be strictly increasing -- they partition one
    timeline, so an out-of-order or duplicated start has no meaning."""
    if not episodes:
        return
    previous = -1
    for episode in episodes:
        if episode.start_index <= previous:
            raise ValueError(
                "Episode start_index values must be strictly increasing; got "
                f"{episode.start_index} after {previous}"
            )
        previous = episode.start_index


def _validate_parent_ref(name: str, parent: str | None, known_bodies: dict) -> None:
    """Raise ValueError if `parent` is self-referential or isn't already in
    `known_bodies`. Requiring the parent to already be known (rather than doing
    a full topological sort) structurally prevents cycles as each body is
    added/parsed: a cycle would require some body to reference a not-yet-known
    name, which this catches immediately."""
    if parent is None:
        return
    if parent == name:
        raise ValueError(f"Body '{name}' cannot be its own parent.")
    if parent not in known_bodies:
        raise ValueError(
            f"Body '{name}' references unknown parent '{parent}'; the parent "
            "must already be defined in the model (added/listed before its children)."
        )


@dataclass
class SimViewModel:
    batch_size: int
    scalar_names: list[str]
    # None means "not known"; the viewer then infers it from consecutive
    # state times.
    dt: float | None
    collapse: bool
    terrain: SimViewTerrain | None = None
    bodies: dict[str, SimViewBody] = field(default_factory=dict)
    static_objects: dict[str, SimViewStaticObject] = field(default_factory=dict)
    batch_names: list[str] | None = None
    # Free-form, JSON-serializable run provenance (engine name, checkpoint path,
    # git commit, CLI args, ...) with no meaning to the viewer itself -- just
    # carried through so a scene saved months ago is still self-describing.
    metadata: dict[str, Any] | None = None
    # Optional episode boundaries for an episodic (e.g. RL) recording -- see
    # SimViewEpisode. None means "one continuous timeline", the default.
    episodes: list[SimViewEpisode] | None = None
    # Initial viewer UI state (see docs/dev/json-format.md "viewerDefaults");
    # lenient on purpose -- the frontend owns the key set.
    viewer_defaults: dict[str, Any] | None = None

    def __post_init__(self):
        if self.viewer_defaults is not None:
            if not isinstance(self.viewer_defaults, dict):
                raise ValueError("viewer_defaults must be a dict.")
            try:
                json.dumps(self.viewer_defaults)
            except TypeError as e:
                raise ValueError(
                    f"viewer_defaults must be JSON-serializable: {e}"
                ) from e
        if self.batch_names is not None and len(self.batch_names) != self.batch_size:
            # Same fallback the viewer applies ("Batch <index>"), so a file it
            # opens fine still loads here.
            logger.warning(
                "Ignoring batch_names: %d name(s) for %d batch(es).",
                len(self.batch_names),
                self.batch_size,
            )
            self.batch_names = None
        _validate_episodes(self.episodes)

    def add_body(self, body: SimViewBody) -> None:
        if body.name in self.bodies:
            raise ValueError(f"Dynamic body {body.name} already exists")
        _validate_parent_ref(body.name, body.parent, self.bodies)
        self.bodies[body.name] = body

    def add_static_object(self, static_object: SimViewStaticObject) -> None:
        if static_object.name in self.static_objects:
            raise ValueError(f"Static object {static_object.name} already exists")
        if not static_object.is_singleton:
            # SimViewStaticObject.__post_init__ guarantees `shapes` is set
            # (not None) whenever `is_singleton` is False.
            assert static_object.shapes is not None
            if len(static_object.shapes) != self.batch_size:
                raise ValueError(
                    f"Batched static object '{static_object.name}' shapes count "
                    f"({len(static_object.shapes)}) must match batch size "
                    f"({self.batch_size})."
                )
        self.static_objects[static_object.name] = static_object

    def to_json(self) -> dict:
        if not self.bodies:
            logger.warning("No dynamic bodies defined in the model.")
        if self.terrain is None:
            raise ValueError("No terrain defined")
        r = {
            "simBatches": self.batch_size,
            "scalarNames": self.scalar_names,
            "dt": self.dt,
            "collapse": self.collapse,
            "terrain": self.terrain.to_json(),
            "bodies": [b.to_json() for b in self.bodies.values()],
            "staticObjects": [s.to_json() for s in self.static_objects.values()],
        }
        if self.batch_names is not None:
            r["batchNames"] = self.batch_names
        if self.metadata is not None:
            r["metadata"] = self.metadata
        if self.episodes:
            r["episodes"] = [e.to_json() for e in self.episodes]
        if self.viewer_defaults is not None:
            r["viewerDefaults"] = self.viewer_defaults
        return r

    @classmethod
    def from_dict(cls, d: dict) -> "SimViewModel":
        """Reconstruct a SimViewModel from the dict produced by `to_json`.

        Centralizes parsing of the wire format: terrain, bodies and static
        objects are all rebuilt via their own `from_dict`, keyed by name so
        `add_body`/`add_static_object`'s uniqueness checks stay meaningful.
        """
        try:
            batch_size = d["simBatches"]
            scalar_names = d["scalarNames"]
            terrain_dict = d["terrain"]
            body_dicts = d["bodies"]
        except KeyError as e:
            raise ValueError(f"Model dict is missing required key: {e}") from e

        bodies = {}
        for body_dict in body_dicts:
            body = SimViewBody.from_dict(body_dict)
            if body.name in bodies:
                raise ValueError(f"Model dict has duplicate body name '{body.name}'")
            _validate_parent_ref(body.name, body.parent, bodies)
            bodies[body.name] = body

        # dt/collapse/staticObjects are optional on the wire (the viewer
        # tolerates all three), so a hand-written file loads here too.
        model = cls(
            batch_size=batch_size,
            scalar_names=scalar_names,
            dt=d.get("dt"),
            collapse=bool(d.get("collapse", False)),
            terrain=SimViewTerrain.from_dict(terrain_dict),
            bodies=bodies,
            batch_names=d.get("batchNames"),
            metadata=d.get("metadata"),
            episodes=(
                [SimViewEpisode.from_dict(e) for e in d["episodes"]]
                if d.get("episodes")
                else None
            ),
            viewer_defaults=d.get("viewerDefaults"),
        )
        # Via add_static_object so duplicate names and a batched object's
        # shapes count are checked exactly as when authoring.
        for static_object_dict in d.get("staticObjects") or []:
            model.add_static_object(SimViewStaticObject.from_dict(static_object_dict))
        return model

    @property
    def is_complete(self) -> bool:
        return self.terrain is not None
