"""Tests for simview.info -- pure stdlib, deliberately no
pytest.importorskip("torch") since the module itself must work on a base
install (see CLAUDE.md's "authoring" extra guard)."""

import base64
import gzip
import json
import struct

from simview.info import format_text, summarize_scene


def _blob(values: list[float]) -> str:
    return (
        "__b64__" + base64.b64encode(struct.pack(f"<{len(values)}f", *values)).decode()
    )


def _minimal_model(batch_size=1, scalar_names=None, bodies=None):
    return {
        "simBatches": batch_size,
        "scalarNames": scalar_names or [],
        "dt": 0.1,
        "collapse": False,
        "terrain": {
            "dimensions": {
                "sizeX": 10.0,
                "sizeY": 10.0,
                "resolutionX": 4,
                "resolutionY": 4,
            },
            "bounds": {
                "minX": -5,
                "maxX": 5,
                "minY": -5,
                "maxY": 5,
                "minZ": 0,
                "maxZ": 0,
            },
            "heightData": [[0.0] * 4] * 4,
            "normals": [[[0, 0, 1]] * 4] * 4,
            "isSingleton": True,
            "properties": {},
        },
        "bodies": bodies
        if bodies is not None
        else [
            {
                "name": "Box",
                "shape": {"type": "box", "hx": 0.5, "hy": 0.5, "hz": 0.5},
                "availableAttributes": ["velocity"],
            }
        ],
        "staticObjects": [],
    }


def _write_scene(tmp_path, model, states, gz=False, name="sim.json"):
    payload = json.dumps({"model": model, "states": states}).encode("utf-8")
    if gz:
        payload = gzip.compress(payload)
        name = name + ".gz"
    path = tmp_path / name
    path.write_bytes(payload)
    return path


def _basic_states():
    return [
        {
            "time": t * 0.1,
            "bodies": [
                {
                    "name": "Box",
                    "bodyTransform": [0, 0, float(t), 1, 0, 0, 0],
                    "velocity": [0, 0, 0],
                }
            ],
            "energy": [1.0],
        }
        for t in range(3)
    ]


def test_summarize_scene_basic_valid_scene(tmp_path):
    model = _minimal_model(scalar_names=["energy"])
    path = _write_scene(tmp_path, model, _basic_states())

    summary = summarize_scene(path)

    assert summary["model"]["batch_size"] == 1
    assert summary["states"]["frame_count"] == 3
    assert summary["states"]["columnar"]["eligible"] is True
    assert summary["states"]["columnar"]["reasons"] == []
    assert summary["warnings"] == []


def test_summarize_scene_reports_metadata(tmp_path):
    model = _minimal_model(scalar_names=["energy"])
    model["metadata"] = {"engine": "torch", "adapt_heads": ["friction", "stiffness"]}
    path = _write_scene(tmp_path, model, _basic_states())

    summary = summarize_scene(path)

    assert summary["model"]["metadata"] == {
        "engine": "torch",
        "adapt_heads": ["friction", "stiffness"],
    }
    text = format_text(summary)
    assert "Metadata" in text
    assert "engine: torch" in text


def test_summarize_scene_metadata_absent_when_unset(tmp_path):
    model = _minimal_model(scalar_names=["energy"])
    path = _write_scene(tmp_path, model, _basic_states())

    summary = summarize_scene(path)

    assert summary["model"]["metadata"] is None
    assert "Metadata" not in format_text(summary)


def test_summarize_scene_gzipped_file(tmp_path):
    model = _minimal_model(scalar_names=["energy"])
    path = _write_scene(tmp_path, model, _basic_states(), gz=True)

    summary = summarize_scene(path)

    assert summary["file"]["gzipped"] is True
    assert summary["states"]["frame_count"] == 3
    assert summary["states"]["columnar"]["eligible"] is True


def test_summarize_scene_missing_model_key(tmp_path):
    path = tmp_path / "sim.json"
    path.write_text(json.dumps({"states": _basic_states()}))

    summary = summarize_scene(path)

    assert summary["model"] is None
    assert any("model" in w for w in summary["warnings"])


def test_summarize_scene_missing_states_key(tmp_path):
    model = _minimal_model()
    path = tmp_path / "sim.json"
    path.write_text(json.dumps({"model": model}))

    summary = summarize_scene(path)

    assert summary["states"] is None
    assert any("states" in w for w in summary["warnings"])


def test_summarize_scene_inconsistent_field_sets_flagged(tmp_path):
    model = _minimal_model()
    states = [
        {
            "time": 0.0,
            "bodies": [
                {"name": "Box", "bodyTransform": [0] * 7, "velocity": [0, 0, 0]}
            ],
        },
        {"time": 0.1, "bodies": [{"name": "Box", "bodyTransform": [0] * 7}]},
    ]
    path = _write_scene(tmp_path, model, states)

    summary = summarize_scene(path)

    assert summary["states"]["columnar"]["eligible"] is False
    assert any(
        "inconsistent field set" in r for r in summary["states"]["columnar"]["reasons"]
    )


def test_summarize_scene_body_first_appears_late_flagged(tmp_path):
    model = _minimal_model()
    states = [
        {"time": 0.0, "bodies": []},
        {"time": 0.1, "bodies": [{"name": "Box", "bodyTransform": [0] * 7}]},
    ]
    path = _write_scene(tmp_path, model, states)

    summary = summarize_scene(path)

    assert summary["states"]["columnar"]["eligible"] is False
    assert any("first appears" in r for r in summary["states"]["columnar"]["reasons"])


def test_summarize_scene_missing_scalar_in_frame_flagged(tmp_path):
    model = _minimal_model(scalar_names=["energy"])
    states = [
        {
            "time": 0.0,
            "bodies": [{"name": "Box", "bodyTransform": [0] * 7}],
            "energy": [1.0],
        },
        {"time": 0.1, "bodies": [{"name": "Box", "bodyTransform": [0] * 7}]},
    ]
    path = _write_scene(tmp_path, model, states)

    summary = summarize_scene(path)

    assert summary["states"]["columnar"]["eligible"] is False
    assert any("energy" in r for r in summary["states"]["columnar"]["reasons"])


def test_summarize_scene_blob_encoded_fields_reported(tmp_path):
    model = _minimal_model()
    states = [
        {
            "time": 0.0,
            "bodies": [{"name": "Box", "bodyTransform": _blob([0, 0, 0, 1, 0, 0, 0])}],
        },
        {
            "time": 0.1,
            "bodies": [{"name": "Box", "bodyTransform": _blob([0, 0, 1, 1, 0, 0, 0])}],
        },
    ]
    path = _write_scene(tmp_path, model, states)

    summary = summarize_scene(path)

    entry = next(iter(summary["states"]["bodies"]["entries"].values()))
    assert entry["fields"]["bodyTransform"]["encoding"] == "blob"
    assert summary["states"]["columnar"]["eligible"] is True


def test_summarize_scene_ragged_contacts_not_a_columnar_blocker(tmp_path):
    model = _minimal_model()
    states = [
        {
            "time": 0.0,
            "bodies": [{"name": "Box", "bodyTransform": [0] * 7, "contacts": [[0, 1]]}],
        },
        {"time": 0.1, "bodies": [{"name": "Box", "bodyTransform": [0] * 7}]},
    ]
    path = _write_scene(tmp_path, model, states)

    summary = summarize_scene(path)

    assert summary["states"]["columnar"]["eligible"] is True
    assert any("contacts" in w and "exempt" in w for w in summary["warnings"])


def test_format_text_contains_expected_sections(tmp_path):
    model = _minimal_model(scalar_names=["energy"])
    path = _write_scene(tmp_path, model, _basic_states())

    summary = summarize_scene(path)
    text = format_text(summary)

    for section in ("Model", "Terrain", "Bodies", "States", "Warnings"):
        assert section in text


def test_format_text_truncates_large_body_list(tmp_path):
    bodies = [
        {"name": f"Body{i}", "shape": {"type": "box", "hx": 0.1, "hy": 0.1, "hz": 0.1}}
        for i in range(25)
    ]
    model = _minimal_model(bodies=bodies)
    path = tmp_path / "sim.json"
    path.write_text(json.dumps({"model": model}))

    summary = summarize_scene(path)
    text = format_text(summary)

    assert summary["model"]["bodies"]["truncated"] is True
    assert "+5 more" in text


def test_summarize_scene_json_roundtrip(tmp_path):
    model = _minimal_model(scalar_names=["energy"])
    path = _write_scene(tmp_path, model, _basic_states())

    summary = summarize_scene(path)

    assert json.loads(json.dumps(summary)) == summary
