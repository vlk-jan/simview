from dataclasses import dataclass

import numpy as np
import torch

from simview.model import OptionalBodyStateAttribute, _encode_blob

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

# Wire keys SimViewBodyState.to_json() may pack as binary float32 blobs, same
# set add_trajectory packs. Contacts are ragged (per-batch index lists) and
# always stay plain JSON.
_BINARY_ELIGIBLE_FIELDS = {"bodyTransform", *TRAJECTORY_VECTOR_FIELDS.values()}


@dataclass
class BodyTrajectory:
    """A whole-timeline pose (and optional vectors) for one body.

    Shapes are ``(T, B, k)`` — T timesteps, B batches — or ``(T, k)`` when the
    scene has a single batch. Orientations are ``[w, x, y, z]`` (scalar-first),
    matching the rest of SimView. Pass a list of these to
    :meth:`SimulationScene.add_trajectory` to append an entire time-series in one
    call instead of building a ``SimViewBodyState`` per frame.

    ``name`` may be a list of body names instead of a single string, to cover
    several bodies that move rigidly together (e.g. links welded to the same
    parent). All named bodies must already exist in the model, and the
    transform/vectors here are applied identically to each of them, avoiding
    the need to duplicate the same data per body.

    If the named body has a ``parent`` set in the model (see
    ``SimulationScene.create_body``), ``positions``/``orientations`` here are
    interpreted as local to that parent's current-frame pose instead of world
    space. A body with a constant ``local_transform`` on the model instead
    must never appear in a ``BodyTrajectory`` at all.
    """

    name: str | list[str]
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
        body_name: str | list[str],
        position: ArrayLike,
        orientation: ArrayLike,
        optional_attributes: dict | None = None,
        binary: bool = True,
    ):
        """``body_name`` may be a list of body names sharing this exact
        transform (and any optional attributes), for bodies that move
        rigidly together — see :class:`BodyTrajectory` for the same idea
        applied to whole trajectories.

        If the named body has a ``parent`` set in the model, ``position``/
        ``orientation`` here are interpreted as local to that parent's
        current-frame pose instead of world space (see
        ``SimulationScene.create_body``).

        With ``binary=True`` (the default, matching
        ``SimulationScene.add_trajectory``), ``bodyTransform`` and any
        provided vector attributes (velocity/angularVelocity/force/torque)
        are packed as float32 ``__b64__`` blobs, shrinking the output file;
        the viewer and :func:`merge_simulation_files` decode these
        transparently. Set ``binary=False`` to emit plain JSON lists."""
        self.body_name = body_name
        self.position = position.tolist()
        self.orientation = orientation.tolist()
        self.binary = binary
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

        fields = {"bodyTransform": body_transform, **self.optional_attrs}
        if self.binary:
            fields = {
                key: (
                    _encode_blob(np.array(value, dtype=np.float32))
                    if key in _BINARY_ELIGIBLE_FIELDS
                    else value
                )
                for key, value in fields.items()
            }
        return {"name": self.body_name, **fields}
