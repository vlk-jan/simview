"""Tests for simview.terrain -- pure stdlib, deliberately no
pytest.importorskip("torch") since the module itself must work on a base
install (see CLAUDE.md's "authoring" extra guard).

Not to be confused with tests/test_terrain.py, which covers authoring-side
terrain batch/singleton handling in SimulationScene.create_terrain."""

import base64
import csv
import io
import json
import struct

import pytest

from simview.terrain import (
    format_along_csv,
    format_along_diff_csv,
    format_along_diff_text,
    format_along_text,
    format_area_csv,
    format_area_diff_csv,
    format_area_diff_text,
    format_area_text,
    format_point_csv,
    format_point_diff_csv,
    format_point_diff_text,
    format_point_text,
    query_along_body,
    query_along_body_diff,
    query_area,
    query_area_diff,
    query_point,
    query_point_diff,
)


def _blob(values: list[float]) -> str:
    return (
        "__b64__" + base64.b64encode(struct.pack(f"<{len(values)}f", *values)).decode()
    )


# 3x3 grid (shape_x=shape_y=3), extent [0, 2] x [0, 2] so grid points fall
# exactly on integer coordinates 0, 1, 2. Row-major (row=y, col=x):
#   y=0: 0 1 2
#   y=1: 3 4 5
#   y=2: 6 7 8
_GRID_VALUES = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]


def _model(height_encoding="blob", batch_size=1, friction=None, stiffness=None):
    if height_encoding == "blob":
        height_data = _blob(_GRID_VALUES * batch_size)
    else:
        rows = [_GRID_VALUES[i * 3 : (i + 1) * 3] for i in range(3)]
        height_data = rows  # shared, no batch dim

    terrain = {
        "dimensions": {"sizeX": 2.0, "sizeY": 2.0, "resolutionX": 3, "resolutionY": 3},
        "bounds": {
            "minX": 0.0,
            "maxX": 2.0,
            "minY": 0.0,
            "maxY": 2.0,
            "minZ": 0.0,
            "maxZ": 8.0,
        },
        "heightData": height_data,
        "normals": [[[0, 0, 1]] * 3] * 3,
        "isSingleton": batch_size == 1,
        "frictionData": friction,
        "stiffnessData": stiffness,
    }
    return {"simBatches": batch_size, "terrain": terrain}


def test_query_point_exact_grid_vertex():
    model = _model()
    result = query_point(model, x=1.0, y=1.0)
    assert result["layers"]["height"]["value"] == pytest.approx(4.0)
    assert result["layers"]["height"]["clamped"] is False


def test_query_point_bilinear_interpolation_between_cells():
    model = _model()
    # Midpoint between (0,0)=0 and (1,0)=1 (and their y=1 neighbors 3,4):
    # x=0.5, y=0 -> average of grid[0][0]=0 and grid[0][1]=1 -> 0.5
    result = query_point(model, x=0.5, y=0.0)
    assert result["layers"]["height"]["value"] == pytest.approx(0.5)

    # A point strictly inside a cell: x=0.5, y=0.5 averages the 4 corners
    # 0, 1, 3, 4 -> 2.0
    result2 = query_point(model, x=0.5, y=0.5)
    assert result2["layers"]["height"]["value"] == pytest.approx(2.0)


def test_query_point_outside_extent_is_clamped():
    model = _model()
    result = query_point(model, x=-5.0, y=-5.0)
    assert result["layers"]["height"]["clamped"] is True
    assert result["layers"]["height"]["value"] == pytest.approx(0.0)


def test_query_area_returns_expected_subgrid_and_coords():
    model = _model()
    result = query_area(model, bounds=(0.0, 1.0, 0.0, 1.0))
    assert result["x_coords"] == pytest.approx([0.0, 1.0])
    assert result["y_coords"] == pytest.approx([0.0, 1.0])
    assert result["layers"]["height"] == [[0.0, 1.0], [3.0, 4.0]]


def test_query_area_whole_extent_default():
    model = _model()
    result = query_area(model)
    assert result["x_coords"] == pytest.approx([0.0, 1.0, 2.0])
    assert result["layers"]["height"] == [
        [0.0, 1.0, 2.0],
        [3.0, 4.0, 5.0],
        [6.0, 7.0, 8.0],
    ]


def test_query_area_with_stride():
    model = _model()
    result = query_area(model, bounds=None, stride=2)
    assert result["x_coords"] == pytest.approx([0.0, 2.0])
    assert result["y_coords"] == pytest.approx([0.0, 2.0])
    assert result["layers"]["height"] == [[0.0, 2.0], [6.0, 8.0]]


def test_query_point_missing_layer_raises():
    model = _model(friction=None)
    with pytest.raises(ValueError, match="not present"):
        query_point(model, x=0.0, y=0.0, layers="friction")


def test_query_point_unknown_layer_raises():
    model = _model()
    with pytest.raises(ValueError, match="unknown layer"):
        query_point(model, x=0.0, y=0.0, layers="bogus")


def test_query_point_batch_selection_on_broadcast_blob():
    grid_a = _GRID_VALUES
    grid_b = [v + 100.0 for v in _GRID_VALUES]
    blob = (
        "__b64__"
        + base64.b64encode(
            struct.pack(f"<{len(grid_a) + len(grid_b)}f", *grid_a, *grid_b)
        ).decode()
    )
    terrain = {
        "dimensions": {"sizeX": 2.0, "sizeY": 2.0, "resolutionX": 3, "resolutionY": 3},
        "bounds": {
            "minX": 0.0,
            "maxX": 2.0,
            "minY": 0.0,
            "maxY": 2.0,
            "minZ": 0.0,
            "maxZ": 8.0,
        },
        "heightData": blob,
        "normals": [[[0, 0, 1]] * 3] * 3,
        "isSingleton": False,
        "frictionData": None,
        "stiffnessData": None,
    }
    model = {"simBatches": 2, "terrain": terrain}

    result_a = query_point(model, x=1.0, y=1.0, batch=0)
    result_b = query_point(model, x=1.0, y=1.0, batch=1)
    assert result_a["layers"]["height"]["value"] == pytest.approx(4.0)
    assert result_b["layers"]["height"]["value"] == pytest.approx(104.0)


def test_query_point_batch_out_of_range_raises():
    model = _model()
    with pytest.raises(ValueError, match="out of range"):
        query_point(model, x=0.0, y=0.0, batch=5)


def test_query_point_shared_plain_list_no_batch_dim():
    model = _model(height_encoding="plain", batch_size=2)
    result = query_point(model, x=1.0, y=1.0, batch=1)
    assert result["layers"]["height"]["value"] == pytest.approx(4.0)


def test_query_point_no_terrain_raises():
    with pytest.raises(ValueError, match="no terrain"):
        query_point({"simBatches": 1, "terrain": None}, x=0.0, y=0.0)


def test_format_point_and_area_text_render():
    model = _model()
    point_result = query_point(model, x=1.0, y=1.0)
    area_result = query_area(model)
    point_text = format_point_text(point_result)
    area_text = format_area_text(area_result)
    assert "height:" in point_text
    assert "height:" in area_text


def test_results_are_json_serializable():
    model = _model()
    point_result = query_point(model, x=1.0, y=1.0)
    area_result = query_area(model)
    assert json.loads(json.dumps(point_result)) == point_result
    assert json.loads(json.dumps(area_result)) == area_result


def _two_batch_model(offset=100.0):
    grid_a = _GRID_VALUES
    grid_b = [v + offset for v in _GRID_VALUES]
    blob = _blob(grid_a + grid_b)
    terrain = {
        "dimensions": {"sizeX": 2.0, "sizeY": 2.0, "resolutionX": 3, "resolutionY": 3},
        "bounds": {
            "minX": 0.0,
            "maxX": 2.0,
            "minY": 0.0,
            "maxY": 2.0,
            "minZ": 0.0,
            "maxZ": 8.0,
        },
        "heightData": blob,
        "normals": [[[0, 0, 1]] * 3] * 3,
        "isSingleton": False,
        "frictionData": None,
        "stiffnessData": None,
    }
    return {"simBatches": 2, "terrain": terrain}


def test_query_point_diff_basic_delta():
    model = _two_batch_model(offset=100.0)
    result = query_point_diff(model, x=1.0, y=1.0, batch_a=0, batch_b=1)
    layer = result["layers"]["height"]
    assert layer["value_a"] == pytest.approx(4.0)
    assert layer["value_b"] == pytest.approx(104.0)
    assert layer["delta"] == pytest.approx(100.0)
    assert layer["abs_delta"] == pytest.approx(100.0)


def test_query_point_diff_batch_a_equals_b_raises():
    model = _two_batch_model()
    with pytest.raises(ValueError, match="must differ"):
        query_point_diff(model, x=0.0, y=0.0, batch_a=0, batch_b=0)


def test_query_point_diff_shared_singleton_zero_delta():
    model = _model(height_encoding="plain", batch_size=2)
    result = query_point_diff(model, x=1.0, y=1.0, batch_a=0, batch_b=1)
    assert result["layers"]["height"]["delta"] == pytest.approx(0.0)


def test_query_area_diff_returns_expected_subgrids_and_delta():
    model = _two_batch_model(offset=100.0)
    result = query_area_diff(model, bounds=(0.0, 1.0, 0.0, 1.0), batch_a=0, batch_b=1)
    layer = result["layers"]["height"]
    assert layer["value_a"] == [[0.0, 1.0], [3.0, 4.0]]
    assert layer["value_b"] == [[100.0, 101.0], [103.0, 104.0]]
    assert layer["delta"] == [[100.0, 100.0], [100.0, 100.0]]
    assert layer["abs_delta"] == [[100.0, 100.0], [100.0, 100.0]]
    assert layer["stats"] == {
        "mean_abs_delta": pytest.approx(100.0),
        "max_abs_delta": pytest.approx(100.0),
        "min_abs_delta": pytest.approx(100.0),
    }


def test_query_area_diff_stats_mean_max_min_for_nonuniform_delta():
    # grid_b = 2 * grid_a, so delta == grid_a itself: values 0..8, mean=4.0.
    grid_a = _GRID_VALUES
    grid_b = [v * 2 for v in _GRID_VALUES]
    terrain = {
        "dimensions": {"sizeX": 2.0, "sizeY": 2.0, "resolutionX": 3, "resolutionY": 3},
        "bounds": {
            "minX": 0.0,
            "maxX": 2.0,
            "minY": 0.0,
            "maxY": 2.0,
            "minZ": 0.0,
            "maxZ": 8.0,
        },
        "heightData": _blob(grid_a + grid_b),
        "normals": [[[0, 0, 1]] * 3] * 3,
        "isSingleton": False,
        "frictionData": None,
        "stiffnessData": None,
    }
    model = {"simBatches": 2, "terrain": terrain}
    result = query_area_diff(model, bounds=None, batch_a=0, batch_b=1)
    stats = result["layers"]["height"]["stats"]
    assert stats["mean_abs_delta"] == pytest.approx(4.0)
    assert stats["max_abs_delta"] == pytest.approx(8.0)
    assert stats["min_abs_delta"] == pytest.approx(0.0)


def test_query_area_diff_with_stride():
    model = _two_batch_model(offset=100.0)
    result = query_area_diff(model, bounds=None, batch_a=0, batch_b=1, stride=2)
    assert result["x_coords"] == pytest.approx([0.0, 2.0])
    assert result["layers"]["height"]["delta"] == [[100.0, 100.0], [100.0, 100.0]]


def test_query_area_diff_batch_out_of_range_raises():
    model = _two_batch_model()
    with pytest.raises(ValueError, match="out of range"):
        query_area_diff(model, bounds=None, batch_a=0, batch_b=5)


def test_format_point_diff_and_area_diff_text_render():
    model = _two_batch_model(offset=100.0)
    point_result = query_point_diff(model, x=1.0, y=1.0, batch_a=0, batch_b=1)
    area_result = query_area_diff(model, bounds=None, batch_a=0, batch_b=1)
    point_text = format_point_diff_text(point_result)
    area_text = format_area_diff_text(area_result)
    assert "delta=" in point_text
    assert "delta" in area_text


def test_diff_results_are_json_serializable():
    model = _two_batch_model(offset=100.0)
    point_result = query_point_diff(model, x=1.0, y=1.0, batch_a=0, batch_b=1)
    area_result = query_area_diff(model, bounds=None, batch_a=0, batch_b=1)
    assert json.loads(json.dumps(point_result)) == point_result
    assert json.loads(json.dumps(area_result)) == area_result


def test_format_point_csv_render():
    model = _model()
    result = query_point(model, x=1.0, y=1.0)
    rows = list(csv.reader(io.StringIO(format_point_csv(result))))
    assert rows[0] == ["layer", "value", "clamped"]
    assert rows[1][0] == "height"
    assert float(rows[1][1]) == pytest.approx(4.0)


def test_format_area_csv_render():
    model = _model()
    result = query_area(model, bounds=(0.0, 1.0, 0.0, 1.0))
    rows = list(csv.reader(io.StringIO(format_area_csv(result))))
    assert rows[0] == ["x", "y", "height"]
    assert len(rows) - 1 == 4  # 2x2 grid
    values = {(float(r[0]), float(r[1])): float(r[2]) for r in rows[1:]}
    assert values[(0.0, 0.0)] == pytest.approx(0.0)
    assert values[(1.0, 1.0)] == pytest.approx(4.0)


def test_format_point_diff_csv_render():
    model = _two_batch_model(offset=100.0)
    result = query_point_diff(model, x=1.0, y=1.0, batch_a=0, batch_b=1)
    rows = list(csv.reader(io.StringIO(format_point_diff_csv(result))))
    assert rows[0] == ["layer", "value_a", "value_b", "delta", "clamped"]
    assert rows[1][0] == "height"
    assert float(rows[1][1]) == pytest.approx(4.0)
    assert float(rows[1][2]) == pytest.approx(104.0)
    assert float(rows[1][3]) == pytest.approx(100.0)


def test_format_area_diff_csv_render():
    model = _two_batch_model(offset=100.0)
    result = query_area_diff(model, bounds=(0.0, 1.0, 0.0, 1.0), batch_a=0, batch_b=1)
    rows = list(csv.reader(io.StringIO(format_area_diff_csv(result))))
    assert rows[0] == ["x", "y", "height_a", "height_b", "height_delta"]
    assert len(rows) - 1 == 4
    by_coord = {(float(r[0]), float(r[1])): r for r in rows[1:]}
    row = by_coord[(1.0, 1.0)]
    assert float(row[2]) == pytest.approx(4.0)
    assert float(row[3]) == pytest.approx(104.0)
    assert float(row[4]) == pytest.approx(100.0)


# --- query_along_body / query_along_body_diff -------------------------------
#
# Reuses the 3x3 grid from _GRID_VALUES (extent [0, 2] x [0, 2], row=y,
# col=x, y=0 row is [0, 1, 2]) so a body driving along y=0 from x=0 to x=2
# samples height values 0, 1, 2 in order.


def _along_transform(x, y=0.0, z=0.0):
    return [x, y, z, 1.0, 0.0, 0.0, 0.0]


def _along_states_single_batch(frames=3):
    """Batch_size=1 states: 'Box' drives from x=0 to x=frames-1 along y=0."""
    states = []
    for t in range(frames):
        states.append(
            {
                "time": t * 0.1,
                "bodies": [
                    {"name": "Box", "bodyTransform": _along_transform(float(t))}
                ],
            }
        )
    return states


def _along_states_two_batch(frames=3):
    """Batch 0 ('a') drives x=0..frames-1 along y=0; batch 1 ('b') drives the
    *reverse* path (x=frames-1..0), so sampling along batch b's path instead
    of batch a's would visibly give different x positions/values -- used to
    prove query_along_body_diff's "batch_a is the reference path" contract."""
    states = []
    for t in range(frames):
        row_a = _along_transform(float(t))
        row_b = _along_transform(float(frames - 1 - t))
        states.append(
            {
                "time": t * 0.1,
                "bodies": [{"name": "Box", "bodyTransform": _blob(row_a + row_b)}],
            }
        )
    return states


def _along_model(batch_size=1, doubled_b=False):
    if batch_size == 1:
        height_data = _blob(_GRID_VALUES)
    else:
        grid_a = _GRID_VALUES
        grid_b = (
            [v * 2 for v in _GRID_VALUES]
            if doubled_b
            else [v + 100.0 for v in _GRID_VALUES]
        )
        height_data = _blob(grid_a + grid_b)
    terrain = {
        "dimensions": {"sizeX": 2.0, "sizeY": 2.0, "resolutionX": 3, "resolutionY": 3},
        "bounds": {
            "minX": 0.0,
            "maxX": 2.0,
            "minY": 0.0,
            "maxY": 2.0,
            "minZ": 0.0,
            "maxZ": 16.0,
        },
        "heightData": height_data,
        "normals": [[[0, 0, 1]] * 3] * 3,
        "isSingleton": batch_size == 1,
        "frictionData": None,
        "stiffnessData": None,
    }
    return {"simBatches": batch_size, "terrain": terrain}


def test_query_along_body_samples_height_along_trajectory():
    model = _along_model(batch_size=1)
    states = _along_states_single_batch()
    result = query_along_body(model, states, body="Box")
    assert result["body"] == "Box"
    assert result["frame_indices"] == [0, 1, 2]
    assert result["x"] == pytest.approx([0.0, 1.0, 2.0])
    assert result["layers"]["height"]["values"] == pytest.approx([0.0, 1.0, 2.0])
    assert result["layers"]["height"]["clamped"] == [False, False, False]
    summary = result["layers"]["height"]["summary"]
    assert summary["mean"] == pytest.approx(1.0)
    assert summary["min"] == pytest.approx(0.0)
    assert summary["max"] == pytest.approx(2.0)
    assert summary["clamped_count"] == 0


def test_query_along_body_every_subsamples_frames():
    model = _along_model(batch_size=1)
    states = _along_states_single_batch(frames=5)
    result = query_along_body(model, states, body="Box", every=2)
    assert result["frame_indices"] == [0, 2, 4]


def test_query_along_body_clamped_out_of_extent_points():
    model = _along_model(batch_size=1)
    # x goes from -5 to -3, entirely outside the [0, 2] extent.
    states = [
        {
            "time": t * 0.1,
            "bodies": [
                {"name": "Box", "bodyTransform": _along_transform(float(t) - 5.0)}
            ],
        }
        for t in range(3)
    ]
    result = query_along_body(model, states, body="Box")
    assert result["layers"]["height"]["clamped"] == [True, True, True]
    assert result["layers"]["height"]["summary"]["clamped_count"] == 3


def test_query_along_body_not_found_raises():
    model = _along_model(batch_size=1)
    states = _along_states_single_batch()
    with pytest.raises(ValueError, match="not found"):
        query_along_body(model, states, body="Nope")


def test_query_along_body_ambiguous_raises():
    model = _along_model(batch_size=1)
    states = [
        {
            "time": 0.0,
            "bodies": [
                {"name": ["A", "B"], "bodyTransform": _blob(_along_transform(0.0))},
                {"name": ["B", "C"], "bodyTransform": _blob(_along_transform(0.0))},
            ],
        }
    ]
    with pytest.raises(ValueError, match="ambiguous"):
        query_along_body(model, states, body="B")


def test_query_along_body_no_terrain_raises():
    states = _along_states_single_batch()
    with pytest.raises(ValueError, match="no terrain"):
        query_along_body({"simBatches": 1, "terrain": None}, states, body="Box")


def test_query_along_body_missing_layer_raises():
    model = _along_model(batch_size=1)
    states = _along_states_single_batch()
    with pytest.raises(ValueError, match="not present"):
        query_along_body(model, states, body="Box", layers="friction")


def test_query_along_body_batch_out_of_range_raises():
    model = _along_model(batch_size=1)
    states = _along_states_single_batch()
    with pytest.raises(ValueError, match="out of range"):
        query_along_body(model, states, body="Box", batch=5)


def test_query_along_body_every_less_than_one_raises():
    model = _along_model(batch_size=1)
    states = _along_states_single_batch()
    with pytest.raises(ValueError, match="every must be"):
        query_along_body(model, states, body="Box", every=0)


def test_query_along_body_results_are_json_serializable():
    model = _along_model(batch_size=1)
    states = _along_states_single_batch()
    result = query_along_body(model, states, body="Box")
    assert json.loads(json.dumps(result)) == result


def test_format_along_text_and_csv_render():
    model = _along_model(batch_size=1)
    states = _along_states_single_batch()
    result = query_along_body(model, states, body="Box")
    text = format_along_text(result)
    assert "Box" in text
    assert "height" in text

    rows = list(csv.reader(io.StringIO(format_along_csv(result))))
    assert rows[0] == ["frame", "time", "x", "y", "height"]
    assert len(rows) - 1 == 3
    assert float(rows[1][4]) == pytest.approx(0.0)


def test_format_along_text_truncates_long_series():
    model = _along_model(batch_size=1)
    states = _along_states_single_batch(frames=25)
    result = query_along_body(model, states, body="Box")
    text = format_along_text(result)
    assert "more frame(s)" in text


def test_format_along_text_no_sampled_frames():
    # Body is a known name (so _resolve_body succeeds) but never has a
    # decodable bodyTransform, so no frames get sampled.
    model = _along_model(batch_size=1)
    states = [{"time": 0.0, "bodies": [{"name": "Box"}]}]
    result = query_along_body(model, states, body="Box")
    assert result["frame_indices"] == []
    text = format_along_text(result)
    assert "never present" in text


def test_query_along_body_diff_samples_along_batch_a_path():
    # grid_b = 2 * grid_a, so along y=0 the delta at x=0,1,2 is 0,1,2 -- if
    # the implementation wrongly sampled along batch b's (reversed) path
    # instead, the x positions and deltas below would come out reversed.
    model = _along_model(batch_size=2, doubled_b=True)
    states = _along_states_two_batch()
    result = query_along_body_diff(model, states, body="Box", batch_a=0, batch_b=1)
    assert result["x"] == pytest.approx([0.0, 1.0, 2.0])  # batch a's path, not b's
    layer = result["layers"]["height"]
    assert layer["value_a"] == pytest.approx([0.0, 1.0, 2.0])
    assert layer["value_b"] == pytest.approx([0.0, 2.0, 4.0])
    assert layer["delta"] == pytest.approx([0.0, 1.0, 2.0])
    stats = layer["stats"]
    assert stats["mean_abs_delta"] == pytest.approx(1.0)
    assert stats["min_abs_delta"] == pytest.approx(0.0)
    assert stats["max_abs_delta"] == pytest.approx(2.0)
    assert stats["clamped_count"] == 0


def test_query_along_body_diff_batch_a_equals_b_raises():
    model = _along_model(batch_size=2, doubled_b=True)
    states = _along_states_two_batch()
    with pytest.raises(ValueError, match="must differ"):
        query_along_body_diff(model, states, body="Box", batch_a=0, batch_b=0)


def test_query_along_body_diff_batch_out_of_range_raises():
    model = _along_model(batch_size=2, doubled_b=True)
    states = _along_states_two_batch()
    with pytest.raises(ValueError, match="out of range"):
        query_along_body_diff(model, states, body="Box", batch_a=0, batch_b=5)


def test_query_along_body_diff_results_are_json_serializable():
    model = _along_model(batch_size=2, doubled_b=True)
    states = _along_states_two_batch()
    result = query_along_body_diff(model, states, body="Box", batch_a=0, batch_b=1)
    assert json.loads(json.dumps(result)) == result


def test_format_along_diff_text_and_csv_render():
    model = _along_model(batch_size=2, doubled_b=True)
    states = _along_states_two_batch()
    result = query_along_body_diff(model, states, body="Box", batch_a=0, batch_b=1)
    text = format_along_diff_text(result)
    assert "Box" in text
    assert "batch_a=0" in text
    assert "batch_b=1" in text

    rows = list(csv.reader(io.StringIO(format_along_diff_csv(result))))
    assert rows[0] == [
        "frame",
        "time",
        "x",
        "y",
        "height_a",
        "height_b",
        "height_delta",
    ]
    assert len(rows) - 1 == 3
    assert float(rows[1][4]) == pytest.approx(0.0)
    assert float(rows[1][5]) == pytest.approx(0.0)
    assert float(rows[3][4]) == pytest.approx(2.0)
    assert float(rows[3][5]) == pytest.approx(4.0)
    assert float(rows[3][6]) == pytest.approx(2.0)


def test_format_along_diff_text_no_sampled_frames():
    model = _along_model(batch_size=2, doubled_b=True)
    states = [{"time": 0.0, "bodies": [{"name": "Box"}]}]
    result = query_along_body_diff(model, states, body="Box", batch_a=0, batch_b=1)
    assert result["frame_indices"] == []
    text = format_along_diff_text(result)
    assert "never present" in text


def test_format_along_diff_text_truncates_long_series():
    model = _along_model(batch_size=2, doubled_b=True)
    states = _along_states_two_batch(frames=25)
    result = query_along_body_diff(model, states, body="Box", batch_a=0, batch_b=1)
    text = format_along_diff_text(result)
    assert "more frame(s)" in text
