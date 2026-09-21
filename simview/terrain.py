"""Numeric terrain queries (single point / area / along a body's
trajectory) for `simview terrain`.

Deliberately dependency-free (stdlib only: json, base64, struct, math via
its imports) so it works on a base install without the `authoring` extra
(torch/einops/numpy) -- see CLAUDE.md. Shares its blob-decoding and
body-resolution helpers with `simview/diff.py` and `simview/info.py` via
`simview.columnar`/`simview.utils`, which are stdlib-only on this read path.

The `--along-body` queries need states (not just the model) plus a decoded
`bodyTransform` row and body-name resolution, same as `simview/diff.py`.

Output is numbers, not a rendered visualization: `query_point`/`query_area`
return plain dicts of floats (JSON-serializable as-is) for scripts/coding
agents to consume directly, with `format_point_text`/`format_area_text`
providing a skimmable terminal rendering of the same data.
"""

import csv
import io
import math
from typing import Any

from simview.columnar import blob_floats, body_key, decode_transform_row
from simview.utils import body_label, cap, resolve_body
from simview.utils import load_scene as load_scene  # re-exported for __main__.py
from simview.utils import load_scene_model as load_scene_model  # re-exported

_MAX_SERIES_ROWS = 10


def _layer_data(terrain: dict, layer: str) -> Any:
    """Raw data value (a `__b64__` blob or plain nested list) for a per-vertex
    terrain layer name -- `"height"` maps to `heightData`; any other name is
    looked up in the arbitrary named `properties` bag (model.py's
    `SimViewTerrain.properties`/`TerrainProperty`)."""
    if layer == "height":
        return terrain["heightData"]
    return (terrain.get("properties") or {})[layer]["data"]


def _require_terrain(model_data: dict) -> dict:
    if not isinstance(model_data, dict):
        raise ValueError("model data is missing or invalid")
    terrain = model_data.get("terrain")
    if terrain is None:
        raise ValueError("model has no terrain")
    return terrain


def _resolve_layers(terrain: dict, layers: str | list[str]) -> list[str]:
    available = ["height", *(terrain.get("properties") or {})]

    if layers == "all":
        return available

    requested = layers if isinstance(layers, list) else [layers]
    for layer in requested:
        if layer not in available:
            raise ValueError(
                f"layer '{layer}' is not present in this terrain; "
                f"available: {available}"
            )
    return requested


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

    flat = blob_floats(value)
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


def _collect_body_names(states_data: list) -> list:
    """All distinct body names/name-groups seen across `states_data`, in
    first-seen order -- the candidate pool `resolve_body` matches `body`
    against."""
    all_names: list = []
    seen_keys = set()
    for state in states_data:
        for entry in state.get("bodies") or []:
            name = entry.get("name")
            if name is None:
                continue
            key = body_key(name)
            if key not in seen_keys:
                seen_keys.add(key)
                all_names.append(name)
    return all_names


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
            _layer_data(terrain, layer), shape_x, shape_y, batch_size, batch
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
            _layer_data(terrain, layer), shape_x, shape_y, batch_size, batch
        )
        layers_out[layer] = [[grid[r][c] for c in cols] for r in rows]

    return {
        "batch": batch,
        "is_singleton": bool(terrain.get("isSingleton", False)),
        "x_coords": x_coords,
        "y_coords": y_coords,
        "layers": layers_out,
    }


def query_point_diff(
    model_data: dict,
    x: float,
    y: float,
    batch_a: int,
    batch_b: int,
    layers: str | list[str] = "all",
) -> dict:
    """Like `query_point`, but samples both `batch_a` and `batch_b` and
    additionally returns their delta (`value_b - value_a`) per layer.

    Returns a JSON-serializable dict: `{"point": {"x", "y"}, "batch_a",
    "batch_b", "is_singleton", "layers": {layer: {"value_a", "value_b",
    "delta", "abs_delta", "clamped"}}}`. Raises `ValueError` on the same
    conditions as `query_point`, plus `batch_a == batch_b`.
    """
    if batch_a == batch_b:
        raise ValueError("batch_a and batch_b must differ")

    result_a = query_point(model_data, x, y, layers, batch_a)
    result_b = query_point(model_data, x, y, layers, batch_b)

    layers_out = {}
    for layer, info_a in result_a["layers"].items():
        info_b = result_b["layers"][layer]
        delta = info_b["value"] - info_a["value"]
        layers_out[layer] = {
            "value_a": info_a["value"],
            "value_b": info_b["value"],
            "delta": delta,
            "abs_delta": abs(delta),
            "clamped": info_a["clamped"] or info_b["clamped"],
        }

    return {
        "point": {"x": x, "y": y},
        "batch_a": batch_a,
        "batch_b": batch_b,
        "is_singleton": result_a["is_singleton"],
        "layers": layers_out,
    }


def query_area_diff(
    model_data: dict,
    bounds: tuple[float, float, float, float] | None,
    batch_a: int,
    batch_b: int,
    layers: str | list[str] = "all",
    stride: int = 1,
) -> dict:
    """Like `query_area`, but samples both `batch_a` and `batch_b` and
    additionally returns their elementwise delta (`value_b - value_a`) per
    layer.

    Returns a JSON-serializable dict: `{"batch_a", "batch_b", "is_singleton",
    "x_coords", "y_coords", "layers": {layer: {"value_a", "value_b",
    "delta", "abs_delta"}}}` (each a nested grid, rows follow `y_coords`,
    columns follow `x_coords`). Raises `ValueError` on the same conditions
    as `query_area`, plus `batch_a == batch_b`.
    """
    if batch_a == batch_b:
        raise ValueError("batch_a and batch_b must differ")

    result_a = query_area(model_data, bounds, layers, batch_a, stride)
    result_b = query_area(model_data, bounds, layers, batch_b, stride)

    layers_out = {}
    for layer, value_a in result_a["layers"].items():
        value_b = result_b["layers"][layer]
        delta = [
            [value_b[ri][ci] - value_a[ri][ci] for ci in range(len(value_a[ri]))]
            for ri in range(len(value_a))
        ]
        abs_delta = [[abs(v) for v in row] for row in delta]
        flat_abs_delta = [v for row in abs_delta for v in row]
        layers_out[layer] = {
            "value_a": value_a,
            "value_b": value_b,
            "delta": delta,
            "abs_delta": abs_delta,
            "stats": {
                "mean_abs_delta": sum(flat_abs_delta) / len(flat_abs_delta),
                "max_abs_delta": max(flat_abs_delta),
                "min_abs_delta": min(flat_abs_delta),
            },
        }

    return {
        "batch_a": batch_a,
        "batch_b": batch_b,
        "is_singleton": result_a["is_singleton"],
        "x_coords": result_a["x_coords"],
        "y_coords": result_a["y_coords"],
        "layers": layers_out,
    }


def _along_stats(values: list[float]) -> dict:
    if not values:
        return {"mean": None, "min": None, "max": None}
    return {"mean": sum(values) / len(values), "min": min(values), "max": max(values)}


def query_along_body(
    model_data: dict,
    states_data: list,
    body: str,
    layers: str | list[str] = "all",
    batch: int = 0,
    every: int = 1,
) -> dict:
    """Bilinearly-interpolated terrain value(s) sampled along `body`'s
    trajectory in batch `batch`, for every `every`-th state where `body` has
    a decodable `bodyTransform`. Answers "what terrain is under this body's
    path" -- e.g. sampling a DRIFT-style scene's friction/stiffness under
    the robot's driven path, per batch.

    `body` is required and resolved the same way as `simview.diff`'s
    `--body`: match the full label (e.g. `"wheel_fl+wheel_fr"`) or any
    single name inside a rigidly-grouped body; raises if no/multiple bodies
    match.

    Returns a JSON-serializable dict: `{"body", "batch", "every",
    "frame_indices", "times", "x", "y", "layers": {layer: {"values",
    "clamped", "summary": {"mean", "min", "max", "clamped_count"}}}}`.
    Raises `ValueError` if the model has no terrain, `batch` is out of
    range, a requested layer isn't present, `every < 1`, or `body` is
    unmatched/ambiguous.
    """
    terrain = _require_terrain(model_data)
    dims = terrain["dimensions"]
    bounds = terrain["bounds"]
    shape_x, shape_y = dims["resolutionX"], dims["resolutionY"]
    min_x, max_x = bounds["minX"], bounds["maxX"]
    min_y, max_y = bounds["minY"], bounds["maxY"]
    batch_size = int(model_data.get("simBatches") or 1)
    if not (0 <= batch < batch_size):
        raise ValueError(f"batch index {batch} out of range [0, {batch_size - 1}]")
    resolved_layers = _resolve_layers(terrain, layers)
    if every < 1:
        raise ValueError(f"every must be >= 1; got {every}")

    all_names = _collect_body_names(states_data)
    target_name = resolve_body(all_names, body)[0]
    key = body_key(target_name)

    grids = {
        layer: _decode_grid(
            _layer_data(terrain, layer), shape_x, shape_y, batch_size, batch
        )
        for layer in resolved_layers
    }

    frame_indices: list[int] = []
    times: list = []
    xs: list[float] = []
    ys: list[float] = []
    layer_values: dict[str, list[float]] = {layer: [] for layer in resolved_layers}
    layer_clamped: dict[str, list[bool]] = {layer: [] for layer in resolved_layers}

    for idx, state in enumerate(states_data):
        if idx % every != 0:
            continue
        entry = next(
            (e for e in state.get("bodies") or [] if body_key(e.get("name")) == key),
            None,
        )
        if entry is None or "bodyTransform" not in entry:
            continue

        row = decode_transform_row(entry["bodyTransform"], batch_size, batch)
        x, y = row[0], row[1]
        frame_indices.append(idx)
        times.append(state.get("time"))
        xs.append(x)
        ys.append(y)
        for layer in resolved_layers:
            value, clamped = _bilinear_sample(
                grids[layer], shape_x, shape_y, min_x, max_x, min_y, max_y, x, y
            )
            layer_values[layer].append(value)
            layer_clamped[layer].append(clamped)

    layers_out = {}
    for layer in resolved_layers:
        values, clamped = layer_values[layer], layer_clamped[layer]
        summary = _along_stats(values)
        summary["clamped_count"] = sum(clamped)
        layers_out[layer] = {"values": values, "clamped": clamped, "summary": summary}

    return {
        "body": body_label(target_name),
        "batch": batch,
        "every": every,
        "frame_indices": frame_indices,
        "times": times,
        "x": xs,
        "y": ys,
        "layers": layers_out,
    }


def query_along_body_diff(
    model_data: dict,
    states_data: list,
    body: str,
    batch_a: int,
    batch_b: int,
    layers: str | list[str] = "all",
    every: int = 1,
) -> dict:
    """Like `query_along_body`, but samples both `batch_a` and `batch_b`'s
    terrains at the same positions and reports the delta.

    The sampling positions come from **`batch_a`'s trajectory only**:
    `batch_a` is the reference path (typically ground truth), and both
    terrains are sampled at the same (x, y) points along it, so the
    reported delta reflects a difference in terrain *properties* under the
    path, not the two batches' trajectories diverging from each other (use
    `simview diff` to measure that separately).

    Returns a JSON-serializable dict: `{"body", "batch_a", "batch_b",
    "every", "frame_indices", "times", "x", "y", "layers": {layer:
    {"value_a", "value_b", "delta", "clamped", "stats": {"mean_abs_delta",
    "max_abs_delta", "min_abs_delta", "clamped_count"}}}}`. Raises
    `ValueError` on the same conditions as `query_along_body`, plus
    `batch_a == batch_b`.
    """
    if batch_a == batch_b:
        raise ValueError("batch_a and batch_b must differ")

    terrain = _require_terrain(model_data)
    batch_size = int(model_data.get("simBatches") or 1)
    for label, b in (("batch_a", batch_a), ("batch_b", batch_b)):
        if not (0 <= b < batch_size):
            raise ValueError(f"{label}={b} out of range [0, {batch_size - 1}]")

    # Positions and batch_a's own values come straight from the single-batch
    # query -- batch_a is the reference path both terrains get sampled along.
    result_a = query_along_body(model_data, states_data, body, layers, batch_a, every)

    dims = terrain["dimensions"]
    bounds = terrain["bounds"]
    shape_x, shape_y = dims["resolutionX"], dims["resolutionY"]
    min_x, max_x = bounds["minX"], bounds["maxX"]
    min_y, max_y = bounds["minY"], bounds["maxY"]
    resolved_layers = list(result_a["layers"])
    xs, ys = result_a["x"], result_a["y"]

    grids_b = {
        layer: _decode_grid(
            _layer_data(terrain, layer), shape_x, shape_y, batch_size, batch_b
        )
        for layer in resolved_layers
    }

    layers_out = {}
    for layer in resolved_layers:
        info_a = result_a["layers"][layer]
        value_a, clamped_a = info_a["values"], info_a["clamped"]
        value_b: list[float] = []
        clamped_b: list[bool] = []
        for x, y in zip(xs, ys):
            v, c = _bilinear_sample(
                grids_b[layer], shape_x, shape_y, min_x, max_x, min_y, max_y, x, y
            )
            value_b.append(v)
            clamped_b.append(c)
        delta = [vb - va for va, vb in zip(value_a, value_b)]
        clamped = [ca or cb for ca, cb in zip(clamped_a, clamped_b)]
        abs_deltas = [abs(v) for v in delta]
        stats = {
            "mean_abs_delta": sum(abs_deltas) / len(abs_deltas) if abs_deltas else None,
            "max_abs_delta": max(abs_deltas) if abs_deltas else None,
            "min_abs_delta": min(abs_deltas) if abs_deltas else None,
            "clamped_count": sum(clamped),
        }
        layers_out[layer] = {
            "value_a": value_a,
            "value_b": value_b,
            "delta": delta,
            "clamped": clamped,
            "stats": stats,
        }

    return {
        "body": result_a["body"],
        "batch_a": batch_a,
        "batch_b": batch_b,
        "every": every,
        "frame_indices": result_a["frame_indices"],
        "times": result_a["times"],
        "x": xs,
        "y": ys,
        "layers": layers_out,
    }


def _write_csv(header: list[str], rows) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    for row in rows:
        writer.writerow(row)
    return buf.getvalue()


def _singleton_note(result: dict) -> list[str]:
    if not result["is_singleton"]:
        return []
    return ["  (terrain is singleton: same data for every batch)"]


def _singleton_diff_note(result: dict) -> list[str]:
    if not result["is_singleton"]:
        return []
    return [
        "  (terrain is singleton: same data for every batch -- a nonzero "
        "delta below likely indicates a bug)"
    ]


def format_point_text(result: dict) -> str:
    lines = [
        f"Point ({result['point']['x']}, {result['point']['y']})  "
        f"batch={result['batch']}"
    ]
    lines.extend(_singleton_note(result))
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
    lines.extend(_singleton_note(result))
    for layer, grid in result["layers"].items():
        lines.append(f"\n{layer}:")
        for row in grid:
            lines.append("  " + " ".join(f"{v:.4g}" for v in row))
    return "\n".join(lines)


def format_point_csv(result: dict) -> str:
    return _write_csv(
        ["layer", "value", "clamped"],
        (
            [layer, info["value"], info["clamped"]]
            for layer, info in result["layers"].items()
        ),
    )


def format_area_csv(result: dict) -> str:
    layers = list(result["layers"])
    return _write_csv(
        ["x", "y", *layers],
        (
            [x, y, *(result["layers"][layer][row_idx][col_idx] for layer in layers)]
            for row_idx, y in enumerate(result["y_coords"])
            for col_idx, x in enumerate(result["x_coords"])
        ),
    )


def format_point_diff_text(result: dict) -> str:
    lines = [
        f"Point ({result['point']['x']}, {result['point']['y']})  "
        f"batch_a={result['batch_a']}  batch_b={result['batch_b']}"
    ]
    lines.extend(_singleton_diff_note(result))
    for layer, info in result["layers"].items():
        note = (
            " (clamped: point is outside the terrain extent)" if info["clamped"] else ""
        )
        lines.append(
            f"  {layer}: a={info['value_a']:.6g}  b={info['value_b']:.6g}  "
            f"delta={info['delta']:+.6g}{note}"
        )
    return "\n".join(lines)


def format_area_diff_text(result: dict) -> str:
    x_coords, y_coords = result["x_coords"], result["y_coords"]
    lines = [
        f"Area x=[{x_coords[0]:.4g}, {x_coords[-1]:.4g}] "
        f"y=[{y_coords[0]:.4g}, {y_coords[-1]:.4g}]  "
        f"({len(x_coords)} x {len(y_coords)} points)  "
        f"batch_a={result['batch_a']}  batch_b={result['batch_b']}"
    ]
    lines.extend(_singleton_diff_note(result))
    for layer, grids in result["layers"].items():
        stats = grids["stats"]
        lines.append(
            f"\n{layer} delta (b - a), |delta|: "
            f"mean={stats['mean_abs_delta']:.4g}  "
            f"max={stats['max_abs_delta']:.4g}  "
            f"min={stats['min_abs_delta']:.4g}:"
        )
        for row in grids["delta"]:
            lines.append("  " + " ".join(f"{v:+.4g}" for v in row))
    return "\n".join(lines)


def format_point_diff_csv(result: dict) -> str:
    return _write_csv(
        ["layer", "value_a", "value_b", "delta", "clamped"],
        (
            [layer, info["value_a"], info["value_b"], info["delta"], info["clamped"]]
            for layer, info in result["layers"].items()
        ),
    )


def format_area_diff_csv(result: dict) -> str:
    layers = list(result["layers"])
    header = ["x", "y"]
    for layer in layers:
        header += [f"{layer}_a", f"{layer}_b", f"{layer}_delta"]

    def _rows():
        for row_idx, y in enumerate(result["y_coords"]):
            for col_idx, x in enumerate(result["x_coords"]):
                row = [x, y]
                for layer in layers:
                    grids = result["layers"][layer]
                    row += [
                        grids["value_a"][row_idx][col_idx],
                        grids["value_b"][row_idx][col_idx],
                        grids["delta"][row_idx][col_idx],
                    ]
                yield row

    return _write_csv(header, _rows())


def format_along_text(result: dict) -> str:
    lines = [
        f"Body '{result['body']}'  batch={result['batch']}  every={result['every']}"
    ]
    if not result["frame_indices"]:
        lines.append(
            "  (body never present with a decodable bodyTransform in the "
            "sampled frames)"
        )
        return "\n".join(lines)

    lines.append(f"  {len(result['frame_indices'])} sampled frame(s)")
    for layer, info in result["layers"].items():
        summary = info["summary"]
        lines.append(
            f"  {layer}: mean={summary['mean']:.6g}  min={summary['min']:.6g}  "
            f"max={summary['max']:.6g}  "
            f"clamped={summary['clamped_count']}/{len(info['values'])}"
        )

    layer_names = list(result["layers"])
    rows = list(
        zip(
            result["frame_indices"],
            result["times"],
            result["x"],
            result["y"],
            *(result["layers"][layer]["values"] for layer in layer_names),
        )
    )
    shown, truncated = cap(rows, _MAX_SERIES_ROWS)
    lines.append(
        "\n  frame  time       x            y            " + "  ".join(layer_names)
    )
    for row in shown:
        frame_idx, t, x, y, *values = row
        t_str = f"{t:.4g}" if isinstance(t, (int, float)) else str(t)
        values_str = "  ".join(f"{v:<12.4g}" for v in values)
        lines.append(f"  {frame_idx:<6} {t_str:<10} {x:<12.4g} {y:<12.4g} {values_str}")
    if truncated:
        lines.append(
            f"  ... (+{len(rows) - len(shown)} more frame(s); use --json for "
            "the full series)"
        )
    return "\n".join(lines)


def format_along_diff_text(result: dict) -> str:
    lines = [
        f"Body '{result['body']}'  batch_a={result['batch_a']}  "
        f"batch_b={result['batch_b']}  every={result['every']}  "
        "(sampled along batch_a's trajectory)"
    ]
    if not result["frame_indices"]:
        lines.append(
            "  (body never present with a decodable bodyTransform in the "
            "sampled frames)"
        )
        return "\n".join(lines)

    lines.append(f"  {len(result['frame_indices'])} sampled frame(s)")
    for layer, info in result["layers"].items():
        stats = info["stats"]
        lines.append(
            f"  {layer} delta (b - a), |delta|: mean={stats['mean_abs_delta']:.4g}  "
            f"max={stats['max_abs_delta']:.4g}  min={stats['min_abs_delta']:.4g}  "
            f"clamped={stats['clamped_count']}/{len(info['delta'])}"
        )

    layer_names = list(result["layers"])
    columns = [result["frame_indices"], result["times"], result["x"], result["y"]]
    for layer in layer_names:
        info = result["layers"][layer]
        columns += [info["value_a"], info["value_b"], info["delta"]]
    rows = list(zip(*columns))
    shown, truncated = cap(rows, _MAX_SERIES_ROWS)

    header = "  ".join(f"{layer}_a/{layer}_b/{layer}_delta" for layer in layer_names)
    lines.append(f"\n  frame  time       x            y            {header}")
    for row in shown:
        frame_idx, t, x, y, *rest = row
        t_str = f"{t:.4g}" if isinstance(t, (int, float)) else str(t)
        rest_str = "  ".join(
            f"{v:+.4g}" if i % 3 == 2 else f"{v:.4g}" for i, v in enumerate(rest)
        )
        lines.append(f"  {frame_idx:<6} {t_str:<10} {x:<12.4g} {y:<12.4g} {rest_str}")
    if truncated:
        lines.append(
            f"  ... (+{len(rows) - len(shown)} more frame(s); use --json for "
            "the full series)"
        )
    return "\n".join(lines)


def format_along_csv(result: dict) -> str:
    """Render `query_along_body`'s output as CSV: one row per frame, full
    series (no truncation) -- CSV output is for scripts, matching the "just
    the numbers, in full" philosophy `--json` already uses everywhere in
    this CLI."""
    layers = list(result["layers"])

    def _rows():
        for i in range(len(result["frame_indices"])):
            row = [
                result["frame_indices"][i],
                result["times"][i],
                result["x"][i],
                result["y"][i],
            ]
            row += [result["layers"][layer]["values"][i] for layer in layers]
            yield row

    return _write_csv(["frame", "time", "x", "y", *layers], _rows())


def format_along_diff_csv(result: dict) -> str:
    """Render `query_along_body_diff`'s output as CSV, full series (no
    truncation)."""
    layers = list(result["layers"])
    header = ["frame", "time", "x", "y"]
    for layer in layers:
        header += [f"{layer}_a", f"{layer}_b", f"{layer}_delta"]

    def _rows():
        for i in range(len(result["frame_indices"])):
            row = [
                result["frame_indices"][i],
                result["times"][i],
                result["x"][i],
                result["y"][i],
            ]
            for layer in layers:
                info = result["layers"][layer]
                row += [info["value_a"][i], info["value_b"][i], info["delta"][i]]
            yield row

    return _write_csv(header, _rows())
