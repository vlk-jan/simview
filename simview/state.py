import torch
from simview.model import OptionalBodyStateAttribute


class SimViewBodyState:
    def __init__(
        self,
        body_name: str,
        position: torch.Tensor,
        orientation: torch.Tensor,
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
            assert key in OptionalBodyStateAttribute, (
                f"Unknown optional attribute: {key}"
            )
            if key == OptionalBodyStateAttribute.CONTACTS:
                value = self._process_contacts(value)
            elif isinstance(value, torch.Tensor):
                value = value.tolist()
            elif isinstance(value, list):
                if all(isinstance(v, torch.Tensor) for v in value):
                    value = [v.tolist() for v in value]
                elif all(isinstance(v, list) for v in value):
                    pass
                else:
                    raise ValueError("Unknown list format")
            else:
                raise ValueError(f"Unknown attribute type for {key}: {type(value)}")
            self.optional_attrs[key] = value

    @staticmethod
    def _process_contacts(contacts: torch.Tensor | list):
        if isinstance(contacts, torch.Tensor):  # tensor
            dtype = contacts.dtype
            if dtype in [torch.bool, torch.float]:  # assume a boolean mask
                return [torch.nonzero(c, as_tuple=True)[0].tolist() for c in contacts]
            elif dtype in [torch.int, torch.long]:  # assume indices
                return contacts.tolist()
        else:  # list of tensors or list of lists
            first = contacts[0]
            if isinstance(first, torch.Tensor):
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
