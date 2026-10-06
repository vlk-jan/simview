"""Build shareable view-link hashes (stdlib-only).

Mirrors `serializeViewState` in `static/js/utils/viewState.js` byte for byte
(tests/test_view.py checks `BOOLEAN_FLAG_KEYS` against the JS array), plus the
startup-only keys `data=<base url>` (static mode) and `ui=0` (hide panels).
"""

from collections.abc import Mapping, Sequence
from urllib.parse import quote

# Bit order of the `flags` bitmask -- must equal BOOLEAN_FLAG_KEYS in viewState.js.
BOOLEAN_FLAG_KEYS = (
    "axesVisible",
    "trailsVisible",
    "smoothInterpolation",
    "terrainProbe",
    "attributeVisible.contacts",
    "attributeVisible.velocity",
    "attributeVisible.angularVelocity",
    "attributeVisible.force",
    "attributeVisible.torque",
    "terrainVisualizationModes.surface",
    "terrainVisualizationModes.wireframe",
    "terrainVisualizationModes.normals",
)


def _num(n: float) -> str:
    # JS: Number(n.toFixed(6)).toString()
    s = f"{float(n):.6f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


def _vec3(name: str, v: Sequence[float]) -> str:
    if len(v) != 3:
        raise ValueError(f"{name} must have 3 components, got {len(v)}")
    return ",".join(_num(x) for x in v)


def view_hash(
    *,
    t: float | None = None,
    cam: Sequence[float] | None = None,
    tgt: Sequence[float] | None = None,
    fov: float | None = None,
    batch: int | None = None,
    body_mode: str | None = None,
    terrain_color_mode: str | None = None,
    flags: Mapping[str, bool] | None = None,
    data: str | None = None,
    ui: bool | None = None,
) -> str:
    """Return a view-link fragment (with leading ``#``) for the viewer.

    `t` is the playback time in seconds, `cam`/`tgt` the camera position and
    orbit target, `batch` the focused batch index, `flags` a map of the dotted
    toggle names in `BOOLEAN_FLAG_KEYS` (unlisted ones default to off).
    `data` (base URL of a static bundle, see `SimulationScene.save_static`) and
    `ui=False` (hide all panels) are startup options, not view state.
    """
    params = []
    if t is not None:
        params.append(f"t={_num(t)}")
    if cam is not None:
        params.append(f"cam={_vec3('cam', cam)}")
    if tgt is not None:
        params.append(f"tgt={_vec3('tgt', tgt)}")
    if fov is not None:
        params.append(f"fov={_num(fov)}")
    if batch is not None:
        params.append(f"b={int(batch)}")
    if body_mode:
        params.append(f"bvm={quote(body_mode, safe='')}")
    if terrain_color_mode:
        params.append(f"tcm={quote(terrain_color_mode, safe='')}")
    if flags is not None:
        unknown = set(flags) - set(BOOLEAN_FLAG_KEYS)
        if unknown:
            raise ValueError(
                f"unknown flag(s) {sorted(unknown)}; use {BOOLEAN_FLAG_KEYS}"
            )
        mask = sum(1 << i for i, k in enumerate(BOOLEAN_FLAG_KEYS) if flags.get(k))
        params.append(f"flags={mask}")
    if params:
        params.insert(0, "v=1")
    if data is not None:
        params.append(f"data={quote(data, safe='')}")
    if ui is False:
        params.append("ui=0")
    return "#" + "&".join(params)
