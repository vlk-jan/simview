import logging
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _version
from typing import TYPE_CHECKING

CACHE_DIR = ".simview_cache"

try:
    __version__ = _version("simview")
except PackageNotFoundError:
    # Editable/source checkout that was never installed as a distribution.
    __version__ = "0.0.0.dev0"
del _version, PackageNotFoundError

# Library best practice: attach a NullHandler to the package root logger so
# `import simview` is silent by default for downstream users. Applications
# (including simview's own CLI, in __main__.py) are responsible for adding
# their own handler(s) if they want to see log output.
logging.getLogger(__name__).addHandler(logging.NullHandler())

# Public authoring API. These live in submodules that depend on the optional
# `authoring` extra (torch, einops), so they are imported lazily: a viewing-only
# install can still `import simview` without those dependencies, and only pays
# the import cost (and dependency requirement) when an authoring symbol is used.
_LAZY_EXPORTS = {
    "SimulationScene": "simview.scene",
    "ViewerHandle": "simview.scene",
    "SimViewBody": "simview.model",
    "SimViewStaticObject": "simview.model",
    "SimViewTerrain": "simview.model",
    "SimViewModel": "simview.model",
    "BodyShapeType": "simview.model",
    "OptionalBodyStateAttribute": "simview.model",
    "SimViewBodyState": "simview.state",
    "BodyTrajectory": "simview.state",
    "LiveViewer": "simview.live",
}

if TYPE_CHECKING:
    from simview.live import LiveViewer
    from simview.model import (
        BodyShapeType,
        OptionalBodyStateAttribute,
        SimViewBody,
        SimViewModel,
        SimViewStaticObject,
        SimViewTerrain,
    )
    from simview.scene import SimulationScene, ViewerHandle
    from simview.state import BodyTrajectory, SimViewBodyState

__all__ = [
    "__version__",
    "CACHE_DIR",
    "SimulationScene",
    "ViewerHandle",
    "SimViewBody",
    "SimViewStaticObject",
    "SimViewTerrain",
    "SimViewModel",
    "BodyShapeType",
    "OptionalBodyStateAttribute",
    "SimViewBodyState",
    "BodyTrajectory",
    "LiveViewer",
]


def __getattr__(name: str):
    module_name = _LAZY_EXPORTS.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    import importlib

    return getattr(importlib.import_module(module_name), name)


def __dir__():
    return sorted(__all__)
