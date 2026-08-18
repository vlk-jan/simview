"""Tests for simview.diff -- pure stdlib, deliberately no
pytest.importorskip("torch") since the module itself must work on a base
install (see CLAUDE.md's "authoring" extra guard)."""

import base64
import csv
import io
import json
import math
import struct

import pytest

from simview.diff import compute_trajectory_diff, format_diff_csv, format_diff_text


def _blob(values: list[float]) -> str:
    return (
        "__b64__" + base64.b64encode(struct.pack(f"<{len(values)}f", *values)).decode()
    )


def _transform(pos, quat):
    return list(pos) + list(quat)


def _states_two_bodies(batch_size=2, frames=3, box_encoding="plain", offset=0.0):
    """`Box` (batch rows nested plain list) and grouped `["FL", "FR"]` (blob),
    each batch's transform identical except a per-frame `offset` applied only
    to batch 1's position, so position_error == offset and orientation stays
    identical (error == 0) unless the caller overrides quats."""
    states = []
    for t in range(frames):
        box_a = _transform([0.0, 0.0, float(t)], [1.0, 0.0, 0.0, 0.0])
        box_b = _transform([0.0 + offset, 0.0, float(t)], [1.0, 0.0, 0.0, 0.0])
        if box_encoding == "plain":
            box_transform = [box_a, box_b]
        else:
            box_transform = _blob(box_a + box_b)

        wheel_a = _transform([1.0, 0.0, float(t)], [1.0, 0.0, 0.0, 0.0])
        wheel_b = _transform([1.0 + offset, 0.0, float(t)], [1.0, 0.0, 0.0, 0.0])
        wheel_transform = _blob(wheel_a + wheel_b)

        states.append(
            {
                "time": t * 0.1,
                "bodies": [
                    {"name": "Box", "bodyTransform": box_transform},
                    {"name": ["FL", "FR"], "bodyTransform": wheel_transform},
                ],
            }
        )
    return states


def _model(batch_size=2):
    return {"simBatches": batch_size}


def test_compute_trajectory_diff_basic_position_and_orientation_error():
    states = _states_two_bodies(offset=1.0)
    result = compute_trajectory_diff(_model(), states, batch_a=0, batch_b=1)
    box = result["bodies"]["Box"]
    assert box["position_error"] == pytest.approx([1.0, 1.0, 1.0])
    assert box["orientation_error_deg"] == pytest.approx([0.0, 0.0, 0.0], abs=1e-6)


def test_compute_trajectory_diff_per_axis_reports_signed_batch_a_minus_b():
    states = _states_two_bodies(offset=1.0)
    result = compute_trajectory_diff(
        _model(), states, batch_a=0, batch_b=1, per_axis=True
    )
    box = result["bodies"]["Box"]
    assert result["per_axis"] is True
    # batch b's x is batch a's x + offset, so err_x = a - b = -offset.
    assert box["err_x"] == pytest.approx([-1.0, -1.0, -1.0])
    assert box["err_y"] == pytest.approx([0.0, 0.0, 0.0])
    assert box["err_z"] == pytest.approx([0.0, 0.0, 0.0])
    assert box["summary"]["err_x"]["mean"] == pytest.approx(-1.0)


def test_compute_trajectory_diff_without_per_axis_omits_axis_fields():
    states = _states_two_bodies(offset=1.0)
    result = compute_trajectory_diff(_model(), states, batch_a=0, batch_b=1)
    assert result["per_axis"] is False
    assert "err_x" not in result["bodies"]["Box"]


def test_compute_trajectory_diff_zero_error_when_batches_identical():
    states = _states_two_bodies(offset=0.0)
    result = compute_trajectory_diff(_model(), states, batch_a=0, batch_b=1)
    for body in result["bodies"].values():
        assert body["summary"]["position_error"]["max"] == pytest.approx(0.0)
        assert body["summary"]["orientation_error_deg"]["max"] == pytest.approx(
            0.0, abs=1e-6
        )


def test_compute_trajectory_diff_body_filter_by_label():
    states = _states_two_bodies(offset=1.0)
    result = compute_trajectory_diff(
        _model(), states, batch_a=0, batch_b=1, body="FL+FR"
    )
    assert set(result["bodies"]) == {"FL+FR"}


def test_compute_trajectory_diff_body_filter_by_group_member_name():
    states = _states_two_bodies(offset=1.0)
    result = compute_trajectory_diff(_model(), states, batch_a=0, batch_b=1, body="FL")
    assert set(result["bodies"]) == {"FL+FR"}


def test_compute_trajectory_diff_body_not_found_raises():
    states = _states_two_bodies()
    with pytest.raises(ValueError, match="not found"):
        compute_trajectory_diff(_model(), states, batch_a=0, batch_b=1, body="Nope")


def test_compute_trajectory_diff_ambiguous_body_raises():
    states = [
        {
            "time": 0.0,
            "bodies": [
                {
                    "name": ["A", "B"],
                    "bodyTransform": _blob(
                        _transform([0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0])
                        + _transform([0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0])
                    ),
                },
                {
                    "name": ["B", "C"],
                    "bodyTransform": _blob(
                        _transform([0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0])
                        + _transform([0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0])
                    ),
                },
            ],
        }
    ]
    with pytest.raises(ValueError, match="ambiguous"):
        compute_trajectory_diff(_model(), states, batch_a=0, batch_b=1, body="B")


def test_compute_trajectory_diff_every_subsamples_frames():
    states = _states_two_bodies(frames=5, offset=1.0)
    result = compute_trajectory_diff(_model(), states, batch_a=0, batch_b=1, every=2)
    assert result["bodies"]["Box"]["frame_indices"] == [0, 2, 4]


def test_compute_trajectory_diff_thresholds_report_first_exceeding_frame():
    states = []
    for t in range(5):
        offset = float(t) * 0.1  # increasing error: 0, 0.1, 0.2, 0.3, 0.4
        box = _transform([0.0, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0])
        box_b = _transform([offset, 0.0, 0.0], [1.0, 0.0, 0.0, 0.0])
        states.append(
            {
                "time": t * 0.1,
                "bodies": [{"name": "Box", "bodyTransform": [box, box_b]}],
            }
        )
    result = compute_trajectory_diff(
        _model(), states, batch_a=0, batch_b=1, pos_threshold=0.25
    )
    assert (
        result["bodies"]["Box"]["summary"]["first_frame_exceeding_pos_threshold"] == 3
    )


def test_compute_trajectory_diff_single_batch_model_raises():
    states = _states_two_bodies(batch_size=1)
    with pytest.raises(ValueError, match="need at least 2"):
        compute_trajectory_diff({"simBatches": 1}, states, batch_a=0, batch_b=1)


def test_compute_trajectory_diff_batch_out_of_range_raises():
    states = _states_two_bodies()
    with pytest.raises(ValueError, match="out of range"):
        compute_trajectory_diff(_model(), states, batch_a=0, batch_b=5)


def test_compute_trajectory_diff_batch_a_equals_b_raises():
    states = _states_two_bodies()
    with pytest.raises(ValueError, match="must differ"):
        compute_trajectory_diff(_model(), states, batch_a=0, batch_b=0)


def test_compute_trajectory_diff_every_less_than_one_raises():
    states = _states_two_bodies()
    with pytest.raises(ValueError, match="every must be"):
        compute_trajectory_diff(_model(), states, batch_a=0, batch_b=1, every=0)


def test_compute_trajectory_diff_no_bodies_raises():
    states = [{"time": 0.0, "bodies": []}]
    with pytest.raises(ValueError, match="no bodies"):
        compute_trajectory_diff(_model(), states, batch_a=0, batch_b=1)


def test_format_diff_text_render():
    states = _states_two_bodies(offset=1.0)
    result = compute_trajectory_diff(_model(), states, batch_a=0, batch_b=1)
    text = format_diff_text(result)
    assert "Box" in text
    assert "pos_err" in text
    assert "rot_err" in text


def test_format_diff_text_truncates_long_series():
    states = _states_two_bodies(frames=25, offset=1.0)
    result = compute_trajectory_diff(_model(), states, batch_a=0, batch_b=1)
    text = format_diff_text(result)
    assert "more frame(s)" in text
    assert text.count("\n  24") == 0  # last frame index shouldn't be printed


def test_results_are_json_serializable():
    states = _states_two_bodies(offset=1.0)
    result = compute_trajectory_diff(_model(), states, batch_a=0, batch_b=1)
    assert json.loads(json.dumps(result)) == result


def test_format_diff_csv_render():
    states = _states_two_bodies(frames=3, offset=1.0)
    result = compute_trajectory_diff(_model(), states, batch_a=0, batch_b=1)
    rows = list(csv.reader(io.StringIO(format_diff_csv(result))))

    assert rows[0] == [
        "body",
        "frame",
        "time",
        "position_error",
        "orientation_error_deg",
    ]
    expected_row_count = sum(
        len(body["frame_indices"]) for body in result["bodies"].values()
    )
    assert len(rows) - 1 == expected_row_count

    first_data_row = rows[1]
    assert first_data_row[0] in result["bodies"]
    assert float(first_data_row[3]) == pytest.approx(1.0)


def test_format_diff_csv_render_per_axis_adds_columns():
    states = _states_two_bodies(frames=3, offset=1.0)
    result = compute_trajectory_diff(
        _model(), states, batch_a=0, batch_b=1, per_axis=True
    )
    rows = list(csv.reader(io.StringIO(format_diff_csv(result))))

    assert rows[0] == [
        "body",
        "frame",
        "time",
        "position_error",
        "orientation_error_deg",
        "err_x",
        "err_y",
        "err_z",
    ]
    first_data_row = rows[1]
    assert float(first_data_row[5]) == pytest.approx(-1.0)
    assert float(first_data_row[6]) == pytest.approx(0.0)
    assert float(first_data_row[7]) == pytest.approx(0.0)


def test_format_diff_text_per_axis_shows_axis_lines():
    states = _states_two_bodies(offset=1.0)
    result = compute_trajectory_diff(
        _model(), states, batch_a=0, batch_b=1, per_axis=True
    )
    text = format_diff_text(result)
    assert "err_x (m):" in text
    assert "err_y (m):" in text
    assert "err_z (m):" in text


def test_quat_angle_matches_known_90_degree_rotation():
    # w,x,y,z: identity vs 90-degree rotation about z: [cos45, 0, 0, sin45]
    states = [
        {
            "time": 0.0,
            "bodies": [
                {
                    "name": "Box",
                    "bodyTransform": [
                        _transform([0, 0, 0], [1.0, 0.0, 0.0, 0.0]),
                        _transform(
                            [0, 0, 0],
                            [math.sqrt(0.5), 0.0, 0.0, math.sqrt(0.5)],
                        ),
                    ],
                }
            ],
        }
    ]
    result = compute_trajectory_diff(_model(), states, batch_a=0, batch_b=1)
    assert result["bodies"]["Box"]["orientation_error_deg"][0] == pytest.approx(
        90.0, abs=1e-3
    )


# --- Parent-relative bodies -------------------------------------------------
#
# A parented body's wire transform is parent-relative, so diffing it raw gave
# different numbers than the browser's Error Metrics panel, which resolves the
# chain to world space first. These pin the resolution that fixed that; the
# matching JS-side expectations live in tests/js/bodyTransforms.test.js.

# Parent yaws 90 deg about +Z in batch 1 but not in batch 0, so composing the
# child's local offset differs per batch -- the whole point of resolving.
_HALF_SQRT2 = math.sqrt(0.5)
_YAW90 = [_HALF_SQRT2, 0.0, 0.0, _HALF_SQRT2]  # [w, x, y, z]
_IDENTITY = [1.0, 0.0, 0.0, 0.0]


def _articulated_model():
    return {
        "simBatches": 2,
        "bodies": [
            {"name": "Chassis", "shape": {}},
            {"name": "Arm", "shape": {}, "parent": "Chassis"},
        ],
    }


def _articulated_states():
    # Chassis at the origin in both batches, but rotated in batch 1.
    chassis = _transform([0.0, 0.0, 0.0], _IDENTITY) + _transform(
        [0.0, 0.0, 0.0], _YAW90
    )
    # Same *local* pose in both batches: 2m out along the parent's +X.
    arm_local = _transform([2.0, 0.0, 0.0], _IDENTITY)
    return [
        {
            "time": 0.0,
            "bodies": [
                {"name": "Chassis", "bodyTransform": _blob(chassis)},
                {"name": "Arm", "bodyTransform": _blob(arm_local + arm_local)},
            ],
        }
    ]


def test_parented_body_is_diffed_in_world_space():
    result = compute_trajectory_diff(
        _articulated_model(), _articulated_states(), batch_a=0, batch_b=1
    )

    # Identical local poses, so the raw wire transforms differ by nothing --
    # comparing them unresolved would have reported zero error.
    arm = result["bodies"]["Arm"]
    # Resolved: batch 0 puts the arm at (2, 0, 0), batch 1's 90 deg yaw puts it
    # at (0, 2, 0) -- a separation of 2*sqrt(2).
    assert arm["position_error"][0] == pytest.approx(2.0 * math.sqrt(2.0))
    # The parent's rotation carries into the child's world orientation too.
    assert arm["orientation_error_deg"][0] == pytest.approx(90.0)

    # The root body itself is unaffected by resolution.
    assert result["bodies"]["Chassis"]["position_error"][0] == pytest.approx(0.0)


def test_rigidly_attached_body_is_diffable():
    """A constant localTransform body never appears in the states, so before
    resolution it could not be diffed at all."""
    model = {
        "simBatches": 2,
        "bodies": [
            {"name": "Chassis", "shape": {}},
            {
                "name": "Sensor",
                "shape": {},
                "parent": "Chassis",
                "localTransform": _transform([2.0, 0.0, 0.0], _IDENTITY),
            },
        ],
    }
    states = _articulated_states()  # contains Chassis (+ an unrelated Arm entry)

    result = compute_trajectory_diff(model, states, batch_a=0, batch_b=1)

    assert "Sensor" in result["bodies"]
    sensor = result["bodies"]["Sensor"]
    assert sensor["summary"]["frame_count"] == 1
    assert sensor["position_error"][0] == pytest.approx(2.0 * math.sqrt(2.0))


def test_unparented_scene_is_unchanged_by_resolution():
    """Scenes with no parents must diff exactly as they did before."""
    states = _states_two_bodies(offset=0.5)
    with_model = compute_trajectory_diff(_model(), states, batch_a=0, batch_b=1)

    assert with_model["bodies"]["Box"]["position_error"] == pytest.approx([0.5] * 3)
    assert with_model["bodies"]["FL+FR"]["position_error"] == pytest.approx([0.5] * 3)


def test_cyclic_parent_chain_raises():
    model = {
        "simBatches": 2,
        "bodies": [
            {"name": "A", "shape": {}, "parent": "B"},
            {"name": "B", "shape": {}, "parent": "A"},
        ],
    }
    with pytest.raises(ValueError, match="cycle"):
        compute_trajectory_diff(model, _articulated_states(), batch_a=0, batch_b=1)


def test_unknown_parent_raises():
    model = {
        "simBatches": 2,
        "bodies": [{"name": "Arm", "shape": {}, "parent": "Nonexistent"}],
    }
    with pytest.raises(ValueError, match="unknown parent"):
        compute_trajectory_diff(model, _articulated_states(), batch_a=0, batch_b=1)
