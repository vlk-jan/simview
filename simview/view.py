"""Build shareable view-link hashes (stdlib-only).

Mirrors `serializeViewState` in `static/js/utils/viewState.js` byte for byte
(tests/test_view.py checks `BOOLEAN_FLAG_KEYS`, the key order and the number
formatting against the JS source), plus the startup-only keys `data=<base
url>` (static mode) and `ui=0` (hide panels).
"""

import math
from collections.abc import Mapping, Sequence
from urllib.parse import quote

# Characters JS's encodeURIComponent leaves alone beyond Python quote()'s
# always-safe set (alphanumerics and "_.-~").
_URI_SAFE = "!'()*"

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
    # JS fmtNum: non-finite -> "0", else Number(n.toFixed(6)).toString().
    n = float(n)
    if not math.isfinite(n):
        return "0"
    if abs(n) >= 1e21:
        # toFixed/toString switch to exponent form here; repr() prints the
        # same shortest round-trip digits with the same "e+NN" exponent.
        return repr(n)
    s = f"{n:.6f}".rstrip("0").rstrip(".")
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
    point_clouds: bool | None = None,
    track: str | None = None,
    color_map: str | None = None,
    speed: float | None = None,
    data: str | None = None,
    ui: bool | None = None,
) -> str:
    """Return a view-link fragment (with leading ``#``) for the viewer.

    `t` is the playback time in seconds, `cam`/`tgt` the camera position and
    orbit target, `batch` the focused batch index, `flags` a map of the dotted
    toggle names in `BOOLEAN_FLAG_KEYS` (unlisted ones default to off).
    `point_clouds`, `track` (a body name, or ``"None"``), `color_map` and
    `speed` are carried as named keys; leaving one ``None`` leaves the
    viewer's current setting alone.
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
        params.append(f"bvm={quote(body_mode, safe=_URI_SAFE)}")
    if terrain_color_mode:
        params.append(f"tcm={quote(terrain_color_mode, safe=_URI_SAFE)}")
    if flags is not None:
        unknown = set(flags) - set(BOOLEAN_FLAG_KEYS)
        if unknown:
            raise ValueError(
                f"unknown flag(s) {sorted(unknown)}; use {BOOLEAN_FLAG_KEYS}"
            )
        mask = sum(1 << i for i, k in enumerate(BOOLEAN_FLAG_KEYS) if flags.get(k))
        params.append(f"flags={mask}")
    if point_clouds is not None:
        params.append(f"pc={int(bool(point_clouds))}")
    if track:
        params.append(f"track={quote(track, safe=_URI_SAFE)}")
    if color_map:
        params.append(f"cmap={quote(color_map, safe=_URI_SAFE)}")
    if speed is not None:
        if speed <= 0:
            raise ValueError(f"speed must be positive; got {speed!r}")
        params.append(f"speed={_num(speed)}")

    if params:
        params.insert(0, "v=1")
    if data is not None:
        params.append(f"data={quote(data, safe=_URI_SAFE)}")
    if ui is False:
        params.append("ui=0")
    return "#" + "&".join(params)
