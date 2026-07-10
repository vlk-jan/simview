import base64
import json
import struct

import pytest
import torch
from conftest import build_scene

from simview.merge import merge_simulation_files
from simview.scene import BodyShapeType, SimulationScene
from simview.state import BodyTrajectory, SimViewBodyState


def _decode_blob(value: str) -> list[float]:
    assert value.startswith("__b64__")
    raw = base64.b64decode(value[7:])
    return list(struct.unpack(f"<{len(raw) // 4}f", raw))


def _decode_blob_per_batch(value: str, batch_size: int) -> list[list[float]]:
    """Decode a terrain __b64__ blob into the plain-list shape merge.py
    expects: one entry per batch, each a flat list of floats."""
    flat = _decode_blob(value)
    width = len(flat) // batch_size
    return [flat[i : i + width] for i in range(0, len(flat), width)]


def build_custom_scene(
    times: list[float], zs: list[float], dt: float = 0.1
) -> SimulationScene:
    """A single-batch scene whose Box body moves to z=zs[i] at time=times[i]."""
    scene = SimulationScene(batch_size=1, scalar_names=["energy"], dt=dt)

    resolution = 4
    heights = torch.zeros(resolution, resolution)
    normals = torch.zeros(3, resolution, resolution)
    normals[2] = 1.0
    scene.create_terrain(
        heightmap=heights, normals=normals, x_lim=(-5, 5), y_lim=(-5, 5)
    )
    scene.create_body(
        body_name="Box", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5
    )

    for t, z in zip(times, zs):
        pos = torch.tensor([[0.0, 0.0, z]])
        quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]])
        state = SimViewBodyState("Box", pos, quat)
        scene.add_state(time=t, body_states=[state], scalar_values={"energy": [z]})

    return scene


def test_merge_concatenates_batches(tmp_path):
    scene_a = build_scene(batch_size=1)
    scene_b = build_scene(batch_size=2)
    path_a, path_b = tmp_path / "a.json", tmp_path / "b.json"
    scene_a.save(path_a)
    scene_b.save(path_b)

    merged = merge_simulation_files([path_a, path_b])

    assert merged["model"]["simBatches"] == 3
    assert len(merged["states"]) == 3  # matches file a's (reference) timeline
    for state in merged["states"]:
        box = state["bodies"][0]
        assert len(box["bodyTransform"]) == 3
        assert len(box["velocity"]) == 3
        assert len(state["energy"]) == 3


def test_merge_resamples_onto_first_file_timeline(tmp_path):
    # Reference file: 3 states at coarse dt.
    ref = build_custom_scene(times=[0.0, 0.1, 0.2], zs=[0.0, 1.0, 2.0], dt=0.1)
    # Other file: finer dt, distinguishable z per sample.
    other = build_custom_scene(
        times=[0.0, 0.05, 0.1, 0.15, 0.2], zs=[10.0, 11.0, 12.0, 13.0, 14.0], dt=0.05
    )
    path_ref, path_other = tmp_path / "ref.json", tmp_path / "other.json"
    ref.save(path_ref)
    other.save(path_other)

    merged = merge_simulation_files([path_ref, path_other])

    assert [s["time"] for s in merged["states"]] == [0.0, 0.1, 0.2]
    # batch 0 = ref, batch 1 = other (nearest-neighbor resampled)
    z_ref = [s["bodies"][0]["bodyTransform"][0][2] for s in merged["states"]]
    z_other = [s["bodies"][0]["bodyTransform"][1][2] for s in merged["states"]]
    assert z_ref == [0.0, 1.0, 2.0]
    assert z_other == [10.0, 12.0, 14.0]


def test_merge_requires_at_least_two_files(tmp_path):
    scene = build_scene(batch_size=1)
    path = tmp_path / "a.json"
    scene.save(path)
    with pytest.raises(ValueError, match="at least 2 files"):
        merge_simulation_files([path])


def test_merge_mismatched_bodies_raises(tmp_path):
    scene_a = build_scene(batch_size=1)
    scene_b = build_custom_scene(times=[0.0, 0.1, 0.2], zs=[0.0, 1.0, 2.0])
    path_a, path_b = tmp_path / "a.json", tmp_path / "b.json"
    scene_a.save(path_a)
    scene_b.save(path_b)

    with pytest.raises(ValueError, match="different bodies"):
        merge_simulation_files([path_a, path_b])


def test_merge_mismatched_terrain_dims_raises(tmp_path):
    scene_a = build_scene(batch_size=1)
    path_a = tmp_path / "a.json"
    scene_a.save(path_a)

    data = json.loads(path_a.read_text())
    data["model"]["terrain"]["dimensions"]["resolutionX"] = 999
    path_b = tmp_path / "b.json"
    path_b.write_text(json.dumps(data))

    with pytest.raises(ValueError, match="terrain dimensions"):
        merge_simulation_files([path_a, path_b])


def test_merge_mismatched_scalar_names_raises(tmp_path):
    scene_a = build_scene(batch_size=1)
    path_a = tmp_path / "a.json"
    scene_a.save(path_a)

    data = json.loads(path_a.read_text())
    data["model"]["scalarNames"] = ["other_scalar"]
    for state in data["states"]:
        state["other_scalar"] = state.pop("energy")
    path_b = tmp_path / "b.json"
    path_b.write_text(json.dumps(data))

    with pytest.raises(ValueError, match="scalarNames"):
        merge_simulation_files([path_a, path_b])


def test_merge_missing_model_bodies_raises_clear_error(tmp_path):
    scene_a = build_scene(batch_size=1)
    path_a = tmp_path / "a.json"
    scene_a.save(path_a)

    data = json.loads(path_a.read_text())
    del data["model"]["bodies"]
    path_b = tmp_path / "malformed.json"
    path_b.write_text(json.dumps(data))

    with pytest.raises(ValueError, match=r"'malformed\.json'.*'model\.bodies'"):
        merge_simulation_files([path_a, path_b])


def test_merge_missing_terrain_raises_clear_error(tmp_path):
    scene_a = build_scene(batch_size=1)
    path_a = tmp_path / "a.json"
    scene_a.save(path_a)

    data = json.loads(path_a.read_text())
    del data["model"]["terrain"]
    path_b = tmp_path / "no_terrain.json"
    path_b.write_text(json.dumps(data))

    with pytest.raises(ValueError, match=r"'no_terrain\.json'.*'model\.terrain'"):
        merge_simulation_files([path_a, path_b])


def test_merge_wrong_type_field_raises_clear_error(tmp_path):
    scene_a = build_scene(batch_size=1)
    path_a = tmp_path / "a.json"
    scene_a.save(path_a)

    data = json.loads(path_a.read_text())
    data["model"]["bodies"] = "not-a-list"
    path_b = tmp_path / "bad_type.json"
    path_b.write_text(json.dumps(data))

    with pytest.raises(ValueError, match=r"'bad_type\.json'.*'model\.bodies'.*str"):
        merge_simulation_files([path_a, path_b])


def test_merge_missing_states_raises_clear_error(tmp_path):
    scene_a = build_scene(batch_size=1)
    path_a = tmp_path / "a.json"
    scene_a.save(path_a)

    data = json.loads(path_a.read_text())
    del data["states"]
    path_b = tmp_path / "no_states.json"
    path_b.write_text(json.dumps(data))

    with pytest.raises(ValueError, match=r"'no_states\.json'.*'states'"):
        merge_simulation_files([path_a, path_b])


def test_merge_empty_states_raises_clear_error(tmp_path):
    scene_a = build_scene(batch_size=1)
    path_a = tmp_path / "a.json"
    scene_a.save(path_a)

    data = json.loads(path_a.read_text())
    data["states"] = []
    path_b = tmp_path / "empty_states.json"
    path_b.write_text(json.dumps(data))

    with pytest.raises(ValueError, match=r"no states"):
        merge_simulation_files([path_a, path_b])


def test_merge_mixed_binary_and_plain_state_fields(tmp_path):
    """B5: one file's per-body state fields are __b64__-encoded, the other's
    are plain JSON lists. Both must merge correctly regardless of order."""
    torch.manual_seed(0)
    T, B = 3, 1
    pos = torch.randn(T, B, 3)
    quat = torch.randn(T, B, 4)
    quat = quat / quat.norm(dim=-1, keepdim=True)

    def build(tag, binary):
        scene = SimulationScene(batch_size=B, scalar_names=[], dt=0.1)
        resolution = 4
        heights = torch.zeros(resolution, resolution)
        normals = torch.zeros(3, resolution, resolution)
        normals[2] = 1.0
        scene.create_terrain(
            heightmap=heights, normals=normals, x_lim=(-5, 5), y_lim=(-5, 5)
        )
        scene.create_body(
            body_name="Box", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5
        )
        scene.add_trajectory(
            [0.0, 0.1, 0.2], [BodyTrajectory("Box", pos + tag, quat)], binary=binary
        )
        path = tmp_path / f"{tag}_{binary}.json"
        scene.save(path)
        return path

    path_bin = build(0.0, binary=True)
    path_plain = build(1.0, binary=False)

    # Sanity check the fixtures actually use different encodings on disk.
    bin_data = json.loads(path_bin.read_text())
    plain_data = json.loads(path_plain.read_text())
    assert isinstance(bin_data["states"][0]["bodies"][0]["bodyTransform"], str)
    assert isinstance(plain_data["states"][0]["bodies"][0]["bodyTransform"], list)

    for first, second in [(path_bin, path_plain), (path_plain, path_bin)]:
        merged = merge_simulation_files([first, second])
        assert merged["model"]["simBatches"] == 2
        transform = merged["states"][0]["bodies"][0]["bodyTransform"]
        assert isinstance(transform, list) and len(transform) == 2
        for row in transform:
            assert isinstance(row, list) and len(row) == 7


def test_merge_gzipped_and_plain_file(tmp_path):
    """Gameplan item 16: merge.py must transparently decompress a gzip-compressed
    input alongside a plain-JSON one."""
    scene_a = build_scene(batch_size=1)
    scene_b = build_scene(batch_size=2)
    path_a = tmp_path / "a.json.gz"
    path_b = tmp_path / "b.json"
    scene_a.save(path_a, compress=True)
    scene_b.save(path_b)

    with open(path_a, "rb") as f:
        assert f.read(2) == b"\x1f\x8b"  # sanity check: actually gzipped

    merged = merge_simulation_files([path_a, path_b])

    assert merged["model"]["simBatches"] == 3
    assert len(merged["states"]) == 3
    for state in merged["states"]:
        box = state["bodies"][0]
        assert len(box["bodyTransform"]) == 3


def test_merge_mixed_binary_and_plain_terrain_data(tmp_path):
    """B5 (terrain variant): one file's terrain heightData/normals are
    __b64__-encoded, the other's are plain JSON lists. Use batch_size=1 so
    each file contributes exactly one (unambiguous) row, independent of the
    singleton-broadcast branch in `_expand_batched`."""
    batch_size = 1
    scene_a = build_scene(batch_size=batch_size)
    path_a = tmp_path / "a.json"
    scene_a.save(path_a)

    data_a = json.loads(path_a.read_text())
    terrain_a = data_a["model"]["terrain"]
    assert isinstance(terrain_a["heightData"], str)  # b64-encoded by default
    expected_row = _decode_blob_per_batch(terrain_a["heightData"], batch_size)[0]

    # Build a second file identical except terrain data is plain JSON lists
    # (one entry per batch, matching what merge.py expects for plain lists).
    data_b = json.loads(json.dumps(data_a))
    terrain_b = data_b["model"]["terrain"]
    terrain_b["heightData"] = _decode_blob_per_batch(
        terrain_b["heightData"], batch_size
    )
    terrain_b["normals"] = _decode_blob_per_batch(terrain_b["normals"], batch_size)
    path_b = tmp_path / "b.json"
    path_b.write_text(json.dumps(data_b))

    merged = merge_simulation_files([path_a, path_b])
    height = merged["model"]["terrain"]["heightData"]
    normals = merged["model"]["terrain"]["normals"]
    # Output is a flat-per-batch list: one entry per merged batch (2 total),
    # each a flat list of floats -- matching the plain-list convention used
    # when all inputs are unencoded.
    assert isinstance(height, list) and len(height) == 2
    assert all(isinstance(row, list) for row in height)
    assert isinstance(normals, list) and len(normals) == 2

    # File A (binary) and file B (plain, same content) should round-trip
    # identically -- this is the crash/corruption this test guards against.
    assert height[0] == pytest.approx(expected_row)
    assert height[1] == pytest.approx(expected_row)
