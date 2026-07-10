from dataclasses import dataclass

import numpy as np
import torch

from simview.model import OptionalBodyStateAttribute

# Accepted array-like input types for authoring calls: torch tensors and numpy
# arrays are both supported so callers don't need torch just to build a scene.
ArrayLike = torch.Tensor | np.ndarray

# Maps a BodyTrajectory field name to the wire key used in each state's body dict.
# These are the numeric per-body fields that add_trajectory can pack as binary
# float32 blobs; contacts are ragged integer lists and stay as JSON.
TRAJECTORY_VECTOR_FIELDS = {
    "velocity": OptionalBodyStateAttribute.VELOCITY.value,
    "angular_velocity": OptionalBodyStateAttribute.ANGULAR_VELOCITY.value,
    "force": OptionalBodyStateAttribute.FORCE.value,
    "torque": OptionalBodyStateAttribute.TORQUE.value,
}


@dataclass
class BodyTrajectory:
    """A whole-timeline pose (and optional vectors) for one body.

    Shapes are ``(T, B, k)`` — T timesteps, B batches — or ``(T, k)`` when the
    scene has a single batch. Orientations are ``[w, x, y, z]`` (scalar-first),
    matching the rest of SimView. Pass a list of these to
    :meth:`SimulationScene.add_trajectory` to append an entire time-series in one
    call instead of building a ``SimViewBodyState`` per frame.
    """

    name: str
    positions: ArrayLike  # (T, B, 3) or (T, 3)
    orientations: ArrayLike  # (T, B, 4) or (T, 4), [w, x, y, z]
    velocity: ArrayLike | None = None  # (T, B, 3) or (T, 3)
    angular_velocity: ArrayLike | None = None
    force: ArrayLike | None = None
    torque: ArrayLike | None = None
    # Optional per-timestep contacts: a sequence of length T, where each entry is
    # anything SimViewBodyState._process_contacts accepts for one frame (a (B, N)
    # boolean/float mask, a (B, N) integer index tensor/array, or a list of
    # per-batch index lists). Kept separate from the numeric vector fields above
    # since contacts are ragged and always shipped as plain JSON, never binary.
    contacts: list | None = None


class SimViewBodyState:
    def __init__(
        self,
        body_name: str,
        position: ArrayLike,
        orientation: ArrayLike,
        optional_attributes: dict | None = None,
    ):
        self.body_name = body_name
        self.position = position.tolist()
        self.orientation = orientation.tolist()
        self._set_optional_attributes(optional_attributes or {})

    def __repr__(self) -> str:
        return f"SimViewBodyState(name={self.body_name}, position={self.position}, orientation={self.orientation}, optional_attrs={self.optional_attrs})"

    def _set_optional_attributes(self, attrs):
        self.optional_attrs = {}
        for key, value in attrs.items():
            try:
                key = OptionalBodyStateAttribute(key)
            except ValueError:
                raise ValueError(f"Unknown optional attribute: {key}")
            if key == OptionalBodyStateAttribute.CONTACTS:
                value = self._process_contacts(value)
            elif isinstance(value, (torch.Tensor, np.ndarray)):
                value = value.tolist()
            elif isinstance(value, list):
                if all(isinstance(v, (torch.Tensor, np.ndarray)) for v in value):
                    value = [v.tolist() for v in value]
                elif all(isinstance(v, list) for v in value):
                    pass
                else:
                    raise ValueError("Unknown list format")
            else:
                raise ValueError(f"Unknown attribute type for {key}: {type(value)}")
            self.optional_attrs[key.value] = value

    @staticmethod
    def _process_contacts(contacts: ArrayLike | list):
        if isinstance(contacts, (torch.Tensor, np.ndarray)):  # tensor / array
            is_torch = isinstance(contacts, torch.Tensor)
            dtype = contacts.dtype
            is_bool = dtype == torch.bool if is_torch else dtype == np.bool_
            is_float = (
                dtype.is_floating_point
                if is_torch
                else np.issubdtype(dtype, np.floating)
            )
            is_complex = (
                dtype.is_complex
                if is_torch
                else np.issubdtype(dtype, np.complexfloating)
            )
            if is_bool or is_float:
                # Boolean mask (floats treated as a mask of non-zero entries)
                if is_torch:
                    return [
                        torch.nonzero(c, as_tuple=True)[0].tolist() for c in contacts
                    ]
                return [np.nonzero(c)[0].tolist() for c in contacts]
            elif not is_complex:  # integer dtype: assume indices
                return contacts.tolist()
            else:
                raise ValueError(f"Unsupported contact tensor dtype: {dtype}")
        else:  # list of tensors/arrays or list of lists
            first = contacts[0]
            if isinstance(first, (torch.Tensor, np.ndarray)):
                return [SimViewBodyState._process_contacts(c) for c in contacts]
            elif isinstance(first, list):
                return contacts
            else:
                raise ValueError("Unknown contact format")

    def to_json(self):
        # Merge position and orientation into bodyTransform
        # position: [x, y, z] or [[x, y, z], ...]
        # orientation: [w, x, y, z] or [[w, x, y, z], ...]
        if len(self.position) > 0 and isinstance(self.position[0], list):
            # Batched
            body_transform = [p + o for p, o in zip(self.position, self.orientation)]
        else:
            # Single
            body_transform = self.position + self.orientation

        return {
            "name": self.body_name,
            "bodyTransform": body_transform,
            **self.optional_attrs,
        }
