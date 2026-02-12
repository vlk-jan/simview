import torch
from einops import rearrange
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


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
class SimViewTerrain:
    extent_x: float
    extent_y: float
    shape_x: float
    shape_y: float
    min_x: float
    min_y: float
    max_x: float
    max_y: float
    min_z: float
    max_z: float
    height_data: list[list[float]]
    normals: list[list[list[float]]]
    is_singleton: bool

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
        }

    @staticmethod
    def create(
        heightmap: torch.Tensor,  # ! remember the x,y indexing is assumed to follow torch's "xy" convention, so increasing column index is increasing x coordinate
        normals: torch.Tensor,
        x_lim: tuple[float, float],
        y_lim: tuple[float, float],
        is_singleton: bool,
    ) -> "SimViewTerrain":
        assert heightmap.ndim == 3, "Heightmap must include a batch dimension"
        assert normals.ndim == 4, "Normals must include a batch dimension"
        assert normals.shape[1] == 3, "Normals must have 3 channels"
        B, Dy, Dx = heightmap.shape
        min_x, max_x = x_lim
        min_y, max_y = y_lim
        min_z = heightmap.min().item()
        max_z = heightmap.max().item()
        extent_x = max_x - min_x
        extent_y = max_y - min_y
        height_data_list = rearrange(heightmap, "b d1 d2 -> b (d1 d2)").tolist()
        normals_list = rearrange(normals, "b c d1 d2 -> b (d1 d2) c").tolist()
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
        )


@dataclass
class SimViewBody:
    name: str
    shape: dict
    available_attributes: list[OptionalBodyStateAttribute] | None = None

    def set_available_attributes(
        self, available_attributes: list[str | OptionalBodyStateAttribute]
    ) -> None:
        if self.available_attributes is not None:
            raise UserWarning("Available attributes already set")
        self.available_attributes = [
            v
            if isinstance(v, OptionalBodyStateAttribute)
            else OptionalBodyStateAttribute(v)
            for v in available_attributes
        ]

    @staticmethod
    def _create_shape_dict(body_type: BodyShapeType, **kwargs) -> dict:
        """Helper to create the shape dictionary, converting tensors."""
        shape_dict = {"type": body_type.value}
        for key, value in kwargs.items():
            if isinstance(value, torch.Tensor):
                # Specific handling for mesh/pointcloud data if needed later
                if (
                    body_type == BodyShapeType.MESH and key in ["vertices", "faces"]
                ) or (body_type == BodyShapeType.POINTCLOUD and key == "points"):
                    assert value.ndim == 2, f"{key} must be a 2D tensor"
                    assert value.shape[1] == 3, f"{key} must have shape (N, 3)"
                    shape_dict[key] = value.tolist()
                else:
                    # General tensor conversion (might need adjustment)
                    shape_dict[key] = (
                        value.tolist() if value.numel() > 1 else value.item()
                    )
            else:
                shape_dict[key] = value
        return shape_dict

    @staticmethod
    def create(
        name: str,
        body_type: BodyShapeType,
        available_attributes: list[OptionalBodyStateAttribute | str] | None = None,
        **kwargs,
    ) -> "SimViewBody":
        shape_dict = SimViewBody._create_shape_dict(body_type, **kwargs)
        body = SimViewBody(name=name, shape=shape_dict)
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
    def create_pointcloud(name: str, points: torch.Tensor, **kwargs) -> "SimViewBody":
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
        return r


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


@dataclass
class SimViewModel:
    batch_size: int
    scalar_names: list[str]
    dt: float
    collapse: bool
    terrain: SimViewTerrain | None = None
    bodies: dict[str, SimViewBody] = field(
        default_factory=dict
    )  # Renamed from 'bodies' for clarity
    static_objects: dict[str, SimViewStaticObject] = field(default_factory=dict)

    def add_terrain(self, terrain: SimViewTerrain) -> None:
        if self.terrain is not None:
            raise ValueError("Terrain already exists")
        self.terrain = terrain

    def add_body(self, body: SimViewBody) -> None:
        if body.name in self.bodies:  # Use renamed attribute
            raise ValueError(f"Dynamic body {body.name} already exists")
        self.bodies[body.name] = body  # Use renamed attribute

    def add_static_object(self, static_object: SimViewStaticObject) -> None:
        if static_object.name in self.static_objects:
            raise ValueError(f"Static object {static_object.name} already exists")
        if (
            not static_object.is_singleton
            and len(static_object.shapes) != self.batch_size
        ):
            raise ValueError(
                f"Batched static object '{static_object.name}' shapes count ({len(static_object.shapes)}) must match batch size ({self.batch_size})."
            )
        self.static_objects[static_object.name] = static_object

    def create_terrain(
        self,
        heightmap: torch.Tensor,
        normals: torch.Tensor,
        x_lim: tuple[float, float],
        y_lim: tuple[float, float],
    ) -> None:
        if heightmap.ndim == 2:
            heightmap = heightmap.unsqueeze(0)  # add batch dim
        if normals.ndim == 3:  # channels first
            normals = normals.unsqueeze(0)  # add batch dim
        B_h = heightmap.shape[0]
        B_n = normals.shape[0]

        is_singleton = (B_h == 1 and self.batch_size > 1) or (
            B_n == 1 and self.batch_size > 1
        )

        if is_singleton:
            if B_h == 1:
                heightmap = heightmap.repeat(self.batch_size, 1, 1)
            if B_n == 1:
                normals = normals.repeat(self.batch_size, 1, 1, 1)
        elif B_h != self.batch_size or B_n != self.batch_size:
            raise ValueError(
                f"Non-singleton terrain dimensions ({B_h}, {B_n}) must match batch size ({self.batch_size})"
            )

        self.terrain = SimViewTerrain.create(
            heightmap=heightmap,
            normals=normals,
            x_lim=x_lim,
            y_lim=y_lim,
            is_singleton=is_singleton,
        )

    def create_body(
        self,
        body_name: str,
        shape_type: BodyShapeType,
        available_attributes: list[OptionalBodyStateAttribute | str] | None = None,
        **kwargs,
    ) -> None:
        if body_name in self.bodies:  # Use renamed attribute
            raise ValueError(f"Dynamic body {body_name} already exists")
        body = SimViewBody.create(
            body_name, shape_type, available_attributes=available_attributes, **kwargs
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
        if not self.bodies:  # Use renamed attribute
            print("Warning: No dynamic bodies defined in the model.")
        if self.terrain is None:
            raise ValueError("No terrain defined")
        r = {
            "simBatches": self.batch_size,
            "scalarNames": self.scalar_names,
            "dt": self.dt,
            "collapse": self.collapse,
            "terrain": self.terrain.to_json(),
            "bodies": [
                b.to_json() for b in self.bodies.values()
            ],  # Use renamed attribute
            "staticObjects": [s.to_json() for s in self.static_objects.values()],
        }
        return r

    @property
    def is_complete(self) -> bool:
        return self.terrain is not None
