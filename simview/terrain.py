"""Numeric terrain queries (single point / area) for `simview terrain`.

Deliberately dependency-free (stdlib only: json, base64, struct, math) so
it works on a base install without the `authoring` extra (torch/einops/
numpy) -- see CLAUDE.md and `simview/info.py`'s module docstring for the
same rationale. Kept as a separate module from `simview/info.py` on
purpose, even though both read the same wire format, to keep the two
debugging tools independently reviewable.

Output is numbers, not a rendered visualization: `query_point`/`query_area`
return plain dicts of floats (JSON-serializable as-is) for scripts/coding
agents to consume directly, with `format_point_text`/`format_area_text`
providing a skimmable terminal rendering of the same data.
"""

import base64
import json
import math
import struct
from pathlib import Path
from typing import Any

from simview.utils import read_maybe_gzipped_bytes

BLOB_PREFIX = "__b64__"

# Wire keys for the three per-vertex terrain layers a point/area query can
# ask for, mapping to SimViewTerrain.to_json()'s dict keys (model.py).
_LAYER_KEYS = {
    "height": "heightData",
    "friction": "frictionData",
    "stiffness": "stiffnessData",
}


def load_scene_model(path: str | Path) -> dict:
    """Read the scene JSON at `path` (transparently gunzipped) and return its
    `model` section. Raises `ValueError`/`json.JSONDecodeError` on malformed
    input -- callers decide how to report that (see
    `simview.__main__.run_terrain`)."""
    data = json.loads(read_maybe_gzipped_bytes(path))
    if not isinstance(data, dict):
        raise ValueError("scene file must contain a JSON object with a 'model' key")
    model = data.get("model")
    if model is None:
        raise ValueError("scene file has no 'model' section")
    return model


def _require_terrain(model_data: dict) -> dict:
    if not isinstance(model_data, dict):
        raise ValueError("model data is missing or invalid")
    terrain = model_data.get("terrain")
    if terrain is None:
        raise ValueError("model has no terrain")
    return terrain


def _resolve_layers(terrain: dict, layers: str | list[str]) -> list[str]:
    available = ["height"]
    if terrain.get("frictionData") is not None:
        available.append("friction")
    if terrain.get("stiffnessData") is not None:
        available.append("stiffness")

    if layers == "all":
        return available

    requested = layers if isinstance(layers, list) else [layers]
    for layer in requested:
        if layer not in _LAYER_KEYS:
            raise ValueError(
                f"unknown layer '{layer}'; expected one of {sorted(_LAYER_KEYS)}"
            )
        if layer not in available:
            raise ValueError(f"layer '{layer}' is not present in this terrain")
    return requested


def _flat_floats(value: Any) -> list[float]:
    """Flatten a terrain field value (a `__b64__` blob or a plain, possibly
    nested, JSON list) into a flat list of floats, without numpy."""
    if isinstance(value, str) and value.startswith(BLOB_PREFIX):
        raw = base64.b64decode(value[len(BLOB_PREFIX) :])
        n = len(raw) // 4
        return list(struct.unpack(f"<{n}f", raw))

    flat: list[float] = []

    def _flatten(x: Any) -> None:
        if isinstance(x, list):
            for item in x:
                _flatten(item)
        else:
            flat.append(float(x))

    _flatten(value)
    return flat


def _decode_grid(
    value: Any, shape_x: int, shape_y: int, batch_size: int, batch_idx: int
) -> list[list[float]]:
    """Decode one terrain field into `batch_idx`'s `(shape_y, shape_x)` grid.

    Handles both wire variants: a blob (always broadcast to all
    `batch_size` batches by `SimViewTerrain.create()`) and a plain nested
    list (which the dataclass's type hint describes as a single 2D grid
    shared across all batches, with no batch dimension) -- see the
    `simview/model.py` `SimViewTerrain.create`/`create_terrain` comments.
    """
    if not (0 <= batch_idx < batch_size):
        raise ValueError(f"batch index {batch_idx} out of range [0, {batch_size - 1}]")

    flat = _flat_floats(value)
    per_batch = shape_x * shape_y
    if len(flat) == per_batch * batch_size:
        start = batch_idx * per_batch
        flat_grid = flat[start : start + per_batch]
    elif len(flat) == per_batch:
        flat_grid = flat  # shared across all batches
    else:
        raise ValueError(
            f"terrain data has {len(flat)} values; expected {per_batch} (shared "
            f"across batches) or {per_batch * batch_size} ({batch_size} batches "
            f"x {per_batch})"
        )
    return [flat_grid[r * shape_x : (r + 1) * shape_x] for r in range(shape_y)]


def _bilinear_sample(
    grid: list[list[float]],
    shape_x: int,
    shape_y: int,
    min_x: float,
    max_x: float,
    min_y: float,
    max_y: float,
    x: float,
    y: float,
) -> tuple[float, bool]:
    """Bilinearly interpolate `grid` (row=y, col=x, per `model.py`'s "column
    index is x" convention) at world point `(x, y)`. Out-of-extent points are
    clamped to the nearest edge, with `clamped=True` returned so callers can
    warn."""
    fx = (x - min_x) / (max_x - min_x) * (shape_x - 1) if max_x != min_x else 0.0
    fy = (y - min_y) / (max_y - min_y) * (shape_y - 1) if max_y != min_y else 0.0

    clamped = False
    if fx < 0:
        fx, clamped = 0.0, True
    elif fx > shape_x - 1:
        fx, clamped = float(shape_x - 1), True
    if fy < 0:
        fy, clamped = 0.0, True
    elif fy > shape_y - 1:
        fy, clamped = float(shape_y - 1), True

    x0 = int(math.floor(fx))
    x1 = min(x0 + 1, shape_x - 1)
    y0 = int(math.floor(fy))
    y1 = min(y0 + 1, shape_y - 1)
    tx = fx - x0
    ty = fy - y0

    v00, v10 = grid[y0][x0], grid[y0][x1]
    v01, v11 = grid[y1][x0], grid[y1][x1]
    value = (
        v00 * (1 - tx) * (1 - ty)
        + v10 * tx * (1 - ty)
        + v01 * (1 - tx) * ty
        + v11 * tx * ty
    )
    return value, clamped


def _grid_index_range(
    lo: float, hi: float, min_b: float, max_b: float, shape: int
) -> tuple[int, int]:
    """Map world-space sub-range `[lo, hi]` to an inclusive grid index range,
    clamped to `[0, shape - 1]`."""
    if max_b == min_b or shape <= 1:
        return 0, shape - 1
    f_lo = (lo - min_b) / (max_b - min_b) * (shape - 1)
    f_hi = (hi - min_b) / (max_b - min_b) * (shape - 1)
    start = max(0, math.ceil(min(f_lo, f_hi)))
    end = min(shape - 1, math.floor(max(f_lo, f_hi)))
    return int(start), int(end)


def _grid_coord(index: int, min_b: float, max_b: float, shape: int) -> float:
    return min_b + index / (shape - 1) * (max_b - min_b) if shape > 1 else min_b


def query_point(
    model_data: dict,
    x: float,
    y: float,
    layers: str | list[str] = "all",
    batch: int = 0,
) -> dict:
    """Bilinearly-interpolated terrain value(s) at world point `(x, y)`.

    Returns a JSON-serializable dict:
    `{"point": {"x", "y"}, "batch", "is_singleton", "layers": {layer:
    {"value", "clamped"}}}`. Raises `ValueError` if the model has no
    terrain, `batch` is out of range, or a requested layer isn't present.
    """
    terrain = _require_terrain(model_data)
    dims = terrain["dimensions"]
    bounds = terrain["bounds"]
    shape_x, shape_y = dims["resolutionX"], dims["resolutionY"]
    min_x, max_x = bounds["minX"], bounds["maxX"]
    min_y, max_y = bounds["minY"], bounds["maxY"]
    batch_size = int(model_data.get("simBatches") or 1)
    resolved_layers = _resolve_layers(terrain, layers)

    layers_out = {}
    for layer in resolved_layers:
        grid = _decode_grid(
            terrain[_LAYER_KEYS[layer]], shape_x, shape_y, batch_size, batch
        )
        value, clamped = _bilinear_sample(
            grid, shape_x, shape_y, min_x, max_x, min_y, max_y, x, y
        )
        layers_out[layer] = {"value": value, "clamped": clamped}

    return {
        "point": {"x": x, "y": y},
        "batch": batch,
        "is_singleton": bool(terrain.get("isSingleton", False)),
        "layers": layers_out,
    }


def query_area(
    model_data: dict,
    bounds: tuple[float, float, float, float] | None = None,
    layers: str | list[str] = "all",
    batch: int = 0,
    stride: int = 1,
) -> dict:
    """Raw terrain value grid over a rectangular area.

    `bounds` is `(xmin, xmax, ymin, ymax)`, or `None` for the whole terrain
    extent. `stride` subsamples every Nth grid point in both directions.
    Returns a JSON-serializable dict: `{"batch", "is_singleton", "x_coords",
    "y_coords", "layers": {layer: [[value, ...], ...]}}` (rows follow
    `y_coords`, columns follow `x_coords`). Raises `ValueError` on the same
    conditions as `query_point`, plus a non-overlapping area or a
    non-positive `stride`.
    """
    terrain = _require_terrain(model_data)
    dims = terrain["dimensions"]
    b = terrain["bounds"]
    shape_x, shape_y = dims["resolutionX"], dims["resolutionY"]
    min_x, max_x = b["minX"], b["maxX"]
    min_y, max_y = b["minY"], b["maxY"]
    batch_size = int(model_data.get("simBatches") or 1)
    resolved_layers = _resolve_layers(terrain, layers)

    if stride < 1:
        raise ValueError(f"stride must be >= 1; got {stride}")

    if bounds is None:
        col_start, col_end = 0, shape_x - 1
        row_start, row_end = 0, shape_y - 1
    else:
        xmin, xmax, ymin, ymax = bounds
        col_start, col_end = _grid_index_range(xmin, xmax, min_x, max_x, shape_x)
        row_start, row_end = _grid_index_range(ymin, ymax, min_y, max_y, shape_y)
        if col_start > col_end or row_start > row_end:
            raise ValueError("requested area does not overlap the terrain extent")

    cols = list(range(col_start, col_end + 1, stride))
    rows = list(range(row_start, row_end + 1, stride))
    x_coords = [_grid_coord(c, min_x, max_x, shape_x) for c in cols]
    y_coords = [_grid_coord(r, min_y, max_y, shape_y) for r in rows]

    layers_out = {}
    for layer in resolved_layers:
        grid = _decode_grid(
            terrain[_LAYER_KEYS[layer]], shape_x, shape_y, batch_size, batch
        )
        layers_out[layer] = [[grid[r][c] for c in cols] for r in rows]

    return {
        "batch": batch,
        "is_singleton": bool(terrain.get("isSingleton", False)),
        "x_coords": x_coords,
        "y_coords": y_coords,
        "layers": layers_out,
    }


def format_point_text(result: dict) -> str:
    lines = [
        f"Point ({result['point']['x']}, {result['point']['y']})  "
        f"batch={result['batch']}"
    ]
    if result["is_singleton"]:
        lines.append("  (terrain is singleton: same data for every batch)")
    for layer, info in result["layers"].items():
        note = (
            " (clamped: point is outside the terrain extent)" if info["clamped"] else ""
        )
        lines.append(f"  {layer}: {info['value']:.6g}{note}")
    return "\n".join(lines)


def format_area_text(result: dict) -> str:
    x_coords, y_coords = result["x_coords"], result["y_coords"]
    lines = [
        f"Area x=[{x_coords[0]:.4g}, {x_coords[-1]:.4g}] "
        f"y=[{y_coords[0]:.4g}, {y_coords[-1]:.4g}]  "
        f"({len(x_coords)} x {len(y_coords)} points)  batch={result['batch']}"
    ]
    if result["is_singleton"]:
        lines.append("  (terrain is singleton: same data for every batch)")
    for layer, grid in result["layers"].items():
        lines.append(f"\n{layer}:")
        for row in grid:
            lines.append("  " + " ".join(f"{v:.4g}" for v in row))
    return "\n".join(lines)
