from typing import TYPE_CHECKING

CACHE_DIR = ".simview_cache"

# Public authoring API. These live in submodules that depend on the optional
# `authoring` extra (torch, einops), so they are imported lazily: a viewing-only
# install can still `import simview` without those dependencies, and only pays
# the import cost (and dependency requirement) when an authoring symbol is used.
_LAZY_EXPORTS = {
    "SimulationScene": "simview.scene",
    "SimViewBody": "simview.model",
    "SimViewStaticObject": "simview.model",
    "SimViewTerrain": "simview.model",
    "SimViewModel": "simview.model",
    "BodyShapeType": "simview.model",
    "OptionalBodyStateAttribute": "simview.model",
    "SimViewBodyState": "simview.state",
}

if TYPE_CHECKING:
    from simview.model import (
        BodyShapeType,
        OptionalBodyStateAttribute,
        SimViewBody,
        SimViewModel,
        SimViewStaticObject,
        SimViewTerrain,
    )
    from simview.scene import SimulationScene
    from simview.state import SimViewBodyState

__all__ = [
    "CACHE_DIR",
    "SimulationScene",
    "SimViewBody",
    "SimViewStaticObject",
    "SimViewTerrain",
    "SimViewModel",
    "BodyShapeType",
    "OptionalBodyStateAttribute",
    "SimViewBodyState",
]


def __getattr__(name: str):
    module_name = _LAZY_EXPORTS.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib

    return getattr(importlib.import_module(module_name), name)


def __dir__():
    return sorted(__all__)
