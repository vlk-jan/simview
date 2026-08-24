import base64
import logging
import math
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, cast

import numpy as np
import torch
from einops import rearrange

logger = logging.getLogger("simview.model")

BLOB_PREFIX = "__b64__"


def _encode_blob(array) -> str:
    """Encode a numpy array as a little-endian float32 base64 blob string.

    The `__b64__` prefix marks the value so the server (and merge) can round-trip
    it as an opaque binary blob instead of verbose JSON.
    """
    return BLOB_PREFIX + base64.b64encode(array.astype("<f4").tobytes()).decode("utf-8")


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


def _decode_blob(value):
    """Decode a `__b64__`-prefixed base64 blob string back into a flat list of
    little-endian float32 values. Values that aren't blob strings (already plain
    JSON lists, or None) pass through unchanged, so callers can use this
    unconditionally on fields that may or may not be binary-encoded."""
    if not (isinstance(value, str) and value.startswith(BLOB_PREFIX)):
        return value
    raw = base64.b64decode(value[len(BLOB_PREFIX) :])
    return np.frombuffer(raw, dtype="<f4").tolist()


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
        string) -- decode with `simview.model._decode_blob` if you need the
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
        min_x, max_x = x_lim
        min_y, max_y = y_lim
        min_z = heightmap.min().item()
        max_z = heightmap.max().item()
        extent_x = max_x - min_x
        extent_y = max_y - min_y
        height_data_list = _encode_blob(
            rearrange(heightmap, "b d1 d2 -> b (d1 d2)").cpu().numpy()
        )
        normals_list = _encode_blob(
            rearrange(normals, "b c d1 d2 -> b (d1 d2) c").cpu().numpy()
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
                data=_encode_blob(
                    rearrange(prop_map, "b d1 d2 -> b (d1 d2)").cpu().numpy()
                ),
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
                rearrange(embedding_map, "b k d1 d2 -> b (d1 d2) k").cpu().numpy()
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

    def __post_init__(self):
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
        return shape_dict

    @staticmethod
    def create(
        name: str,
        body_type: BodyShapeType,
        available_attributes: list[OptionalBodyStateAttribute | str] | None = None,
        parent: str | None = None,
        local_transform: Any | None = None,
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
    def create_sphere(name: str, radius: float, **kwargs) -> "SimViewBody":
        return SimViewBody.create(name, BodyShapeType.SPHERE, radius=radius, **kwargs)

    @staticmethod
    def create_cylinder(
        name: str, radius: float, height: float, **kwargs
    ) -> "SimViewBody":
        return SimViewBody.create(
            name, BodyShapeType.CYLINDER, radius=radius, height=height, **kwargs
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
        if color is not None:
            if tuple(color.shape) != (N, 3):
                raise ValueError(
                    f"color must have shape ({N}, 3) matching points; got {tuple(color.shape)}."
                )
            kwargs["color"] = color
        if embedding is not None:
            if embedding.ndim != 2 or embedding.shape[0] != N:
                raise ValueError(
                    f"embedding must have shape ({N}, K) matching points; got {tuple(embedding.shape)}."
                )
            kwargs["embedding"] = embedding
        return SimViewBody.create(
            name, BodyShapeType.POINTCLOUD, points=points, **kwargs
        )

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
        )


@dataclass
class SimViewStaticObject:
    name: str
    is_singleton: bool
    shape: dict | None = None  # Used if is_singleton is True
    shapes: list[dict] | None = None  # Used if is_singleton is False

    def __post_init__(self):
        if self.is_singleton and self.shape is None:
            raise ValueError("Singleton static object requires 'shape'.")
        if not self.is_singleton and self.shapes is None:
            raise ValueError("Batched static object requires 'shapes'.")
        if self.is_singleton and self.shapes is not None:
            raise ValueError("Singleton static object cannot have 'shapes'.")
        if not self.is_singleton and self.shape is not None:
            raise ValueError("Batched static object cannot have 'shape'.")
        # Basic validation for batched shapes length could be added if batch_size is known here

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
    dt: float
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

    def __post_init__(self):
        if self.batch_names is not None and len(self.batch_names) != self.batch_size:
            raise ValueError(
                f"batch_names length ({len(self.batch_names)}) must match batch size ({self.batch_size})"
            )
        _validate_episodes(self.episodes)

    def add_terrain(self, terrain: SimViewTerrain) -> None:
        if self.terrain is not None:
            raise ValueError("Terrain already exists")
        self.terrain = terrain

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
        """Adds terrain to the internal simulation model.

        Args:
            heightmap (torch.Tensor): 2D or 3D tensor of terrain heights.
            normals (torch.Tensor | None): 3D or 4D tensor of terrain normals. If None,
                normals are automatically computed from the heightmap gradients.
            x_lim (tuple[float, float] | None): (min, max) coordinates for the X axis.
            y_lim (tuple[float, float] | None): (min, max) coordinates for the Y axis.
            grid_res (float | None): Grid resolution. If x_lim and y_lim are omitted,
                they will be automatically inferred assuming the grid is centered at 0.
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
        if heightmap.ndim == 2:
            heightmap = heightmap.unsqueeze(0)  # add batch dim

        if x_lim is None or y_lim is None:
            if grid_res is None:
                raise ValueError("Must provide either (x_lim, y_lim) or grid_res")
            H_dim, W_dim = heightmap.shape[-2:]
            x_lim = x_lim or (-W_dim * grid_res / 2.0, W_dim * grid_res / 2.0)
            y_lim = y_lim or (-H_dim * grid_res / 2.0, H_dim * grid_res / 2.0)

        if normals is None:
            H_dim, W_dim = heightmap.shape[-2:]
            res_x = (x_lim[1] - x_lim[0]) / W_dim
            res_y = (y_lim[1] - y_lim[0]) / H_dim
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
            if tensor is not None and tensor.shape[0] not in (1, self.batch_size):
                raise ValueError(
                    f"Terrain '{name}' batch dim ({tensor.shape[0]}) must be 1 "
                    f"(shared) or {self.batch_size} (per-batch)."
                )

        # Singleton only when every provided field is shared and there is more than
        # one batch to share it across.
        is_singleton = self.batch_size > 1 and all(
            tensor.shape[0] == 1 for tensor in provided.values() if tensor is not None
        )

        # A fully-shared (singleton) terrain ships exactly one copy of every
        # field -- the viewer, merge, and `simview terrain` all detect the
        # shared row by its length (resolution-sized instead of
        # batch_size * resolution). Only the mixed case (some fields shared,
        # some per-batch) broadcasts the shared ones, since a non-singleton
        # terrain's fields must all be batch_size rows.
        if self.batch_size > 1 and not is_singleton:
            if heightmap.shape[0] == 1:
                heightmap = heightmap.repeat(self.batch_size, 1, 1)
            if normals.shape[0] == 1:
                normals = normals.repeat(self.batch_size, 1, 1, 1)
            properties = {
                name: (
                    prop.repeat(self.batch_size, 1, 1) if prop.shape[0] == 1 else prop
                )
                for name, prop in properties.items()
            }
            if embedding_map is not None and embedding_map.shape[0] == 1:
                embedding_map = embedding_map.repeat(self.batch_size, 1, 1, 1)

        self.terrain = SimViewTerrain.create(
            heightmap=heightmap,
            normals=normals,
            x_lim=x_lim,
            y_lim=y_lim,
            is_singleton=is_singleton,
            properties=properties,
            property_bounds=property_bounds,
            embedding_map=embedding_map,
        )

    def create_body(
        self,
        body_name: str,
        shape_type: BodyShapeType,
        available_attributes: list[OptionalBodyStateAttribute | str] | None = None,
        parent: str | None = None,
        local_transform: Any | None = None,
        **kwargs,
    ) -> None:
        if body_name in self.bodies:
            raise ValueError(f"Dynamic body {body_name} already exists")
        body = SimViewBody.create(
            body_name,
            shape_type,
            available_attributes=available_attributes,
            parent=parent,
            local_transform=local_transform,
            **kwargs,
        )
        self.add_body(body)

    def create_static_object_singleton(
        self, name: str, shape_type: BodyShapeType, **kwargs
    ) -> None:
        static_obj = SimViewStaticObject.create_singleton(name, shape_type, **kwargs)
        self.add_static_object(static_obj)

    def create_static_object_batched(
        self, name: str, shape_type: BodyShapeType, shapes_kwargs: list[dict[str, Any]]
    ) -> None:
        """Helper method to create and add a batched static object."""
        if len(shapes_kwargs) != self.batch_size:
            raise ValueError(
                f"Length of shapes_kwargs ({len(shapes_kwargs)}) must match batch size ({self.batch_size}) for '{name}'."
            )
        static_obj = SimViewStaticObject.create_batched(name, shape_type, shapes_kwargs)
        self.add_static_object(
            static_obj
        )  # add_static_object already performs the length check

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
            dt = d["dt"]
            collapse = d["collapse"]
            terrain_dict = d["terrain"]
            body_dicts = d["bodies"]
            static_object_dicts = d["staticObjects"]
        except KeyError as e:
            raise ValueError(f"Model dict is missing required key: {e}") from e

        bodies = {}
        for body_dict in body_dicts:
            body = SimViewBody.from_dict(body_dict)
            if body.name in bodies:
                raise ValueError(f"Model dict has duplicate body name '{body.name}'")
            _validate_parent_ref(body.name, body.parent, bodies)
            bodies[body.name] = body

        static_objects = {}
        for static_object_dict in static_object_dicts:
            static_object = SimViewStaticObject.from_dict(static_object_dict)
            static_objects[static_object.name] = static_object

        return cls(
            batch_size=batch_size,
            scalar_names=scalar_names,
            dt=dt,
            collapse=collapse,
            terrain=SimViewTerrain.from_dict(terrain_dict),
            bodies=bodies,
            static_objects=static_objects,
            batch_names=d.get("batchNames"),
            metadata=d.get("metadata"),
            episodes=(
                [SimViewEpisode.from_dict(e) for e in d["episodes"]]
                if d.get("episodes")
                else None
            ),
        )

    @property
    def is_complete(self) -> bool:
        return self.terrain is not None
