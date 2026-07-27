"""Tests for simview.terrain -- pure stdlib, deliberately no
pytest.importorskip("torch") since the module itself must work on a base
install (see CLAUDE.md's "authoring" extra guard).

Not to be confused with tests/test_terrain.py, which covers authoring-side
terrain batch/singleton handling in SimulationScene.create_terrain."""

import base64
import json
import struct

import pytest

from simview.terrain import (
    format_area_diff_text,
    format_area_text,
    format_point_diff_text,
    format_point_text,
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
