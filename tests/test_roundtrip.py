import gzip
import json

import pytest
import torch
from conftest import build_scene

from simview.model import (
    BodyShapeType,
    OptionalBodyStateAttribute,
    SimViewBody,
    SimViewModel,
    SimViewStaticObject,
    SimViewTerrain,
    _decode_blob,
    _encode_blob,
)
from simview.scene import SimulationScene
from simview.state import BodyTrajectory


def test_save_produces_loadable_json(tmp_path):
    scene = build_scene(batch_size=2)
    out = tmp_path / "sim.json"
    scene.save(out)

    with open(out) as f:
        data = json.load(f)

    assert set(data.keys()) == {"model", "states"}
    model = data["model"]
    assert model["simBatches"] == 2
    assert model["scalarNames"] == ["energy"]
    assert model["dt"] == 0.1
    assert model["bodies"][0]["name"] == "Box"
    # Shape type is a string, not an integer code.
    assert model["bodies"][0]["shape"]["type"] == "box"
    assert model["bodies"][0]["availableAttributes"] == ["velocity"]


def test_terrain_ships_friction_and_stiffness_bounds(tmp_path):
    scene = build_scene(batch_size=2)
    out = tmp_path / "sim.json"
    scene.save(out)

    bounds = json.loads(out.read_text())["model"]["terrain"]["bounds"]
    assert bounds["minFriction"] == 0.5
    assert bounds["maxFriction"] == 0.5
    assert bounds["minStiffness"] == 250000.0
    assert bounds["maxStiffness"] == 250000.0


def test_states_shape(tmp_path):
    scene = build_scene(batch_size=2)
    out = tmp_path / "sim.json"
    scene.save(out)

    states = json.loads(out.read_text())["states"]
    assert len(states) == 3
    first = states[0]
    assert first["time"] == 0.0
    assert len(first["energy"]) == 2
    box = first["bodies"][0]
    # bodyTransform is [x, y, z, w, qx, qy, qz] per batch.
    assert len(box["bodyTransform"]) == 2
    assert len(box["bodyTransform"][0]) == 7
    assert len(box["velocity"]) == 2


def test_decode_blob_reverses_encode_blob():
    import numpy as np

    array = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]], dtype="<f4")
    blob = _encode_blob(array)
    assert blob.startswith("__b64__")
    assert _decode_blob(blob) == pytest.approx(array.flatten().tolist())


def test_decode_blob_passes_through_non_blob_values():
    assert _decode_blob([1, 2, 3]) == [1, 2, 3]
    assert _decode_blob(None) is None


def test_terrain_to_json_from_dict_roundtrip():
    terrain = SimViewTerrain(
        extent_x=10.0,
        extent_y=10.0,
        shape_x=4,
        shape_y=4,
        min_x=-5.0,
        min_y=-5.0,
        max_x=5.0,
        max_y=5.0,
        min_z=0.0,
        max_z=1.0,
        height_data=[[0.0] * 4] * 4,
        normals=[[[0.0, 0.0, 1.0]] * 4] * 4,
        is_singleton=False,
        friction_data=[[0.5] * 4] * 4,
        stiffness_data=[[250000.0] * 4] * 4,
        min_friction=0.5,
        max_friction=0.5,
        min_stiffness=250000.0,
        max_stiffness=250000.0,
    )
    restored = SimViewTerrain.from_dict(terrain.to_json())
    assert restored == terrain


def test_body_to_json_from_dict_roundtrip():
    body = SimViewBody.create_box(
        "Box", hx=0.5, hy=0.5, hz=0.5, available_attributes=["velocity"]
    )
    restored = SimViewBody.from_dict(body.to_json())
    assert restored.name == body.name
    assert restored.shape == body.shape
    assert restored.available_attributes == [OptionalBodyStateAttribute.VELOCITY]


def test_static_object_to_json_from_dict_roundtrip():
    singleton = SimViewStaticObject.create_singleton(
        "Wall", BodyShapeType.BOX, hx=1.0, hy=1.0, hz=1.0
    )
    restored = SimViewStaticObject.from_dict(singleton.to_json())
    assert restored == singleton

    batched = SimViewStaticObject.create_batched(
        "Pillars",
        BodyShapeType.CYLINDER,
        [{"radius": 0.1, "height": 1.0}, {"radius": 0.2, "height": 2.0}],
    )
    restored_batched = SimViewStaticObject.from_dict(batched.to_json())
    assert restored_batched == batched


def test_model_to_json_from_dict_roundtrip():
    scene = build_scene(batch_size=2)
    model = scene.model
    restored = SimViewModel.from_dict(model.to_json())
    assert restored.to_json() == model.to_json()


def test_scene_save_load_save_equivalence(tmp_path):
    scene = build_scene(batch_size=2)
    out1 = tmp_path / "sim1.json"
    out2 = tmp_path / "sim2.json"
    scene.save(out1)

    loaded = SimulationScene.load(out1)
    loaded.save(out2)

    data1 = json.loads(out1.read_text())
    data2 = json.loads(out2.read_text())
    assert data1 == data2


def test_scene_save_load_save_equivalence_with_binary_trajectory(tmp_path):
    T, B = 5, 2
    scene = SimulationScene(batch_size=B, scalar_names=["energy"], dt=0.1)
    resolution = 4
    heights = torch.zeros(resolution, resolution)
    normals = torch.zeros(3, resolution, resolution)
    normals[2] = 1.0
    scene.create_terrain(
        heightmap=heights, normals=normals, x_lim=(-5, 5), y_lim=(-5, 5)
    )
    scene.create_body(
        body_name="Box",
        shape_type=BodyShapeType.BOX,
        available_attributes=["velocity"],
        hx=0.5,
        hy=0.5,
        hz=0.5,
    )
    torch.manual_seed(0)
    pos = torch.randn(T, B, 3)
    quat = torch.randn(T, B, 4)
    quat = quat / quat.norm(dim=-1, keepdim=True)
    vel = torch.randn(T, B, 3)
    scene.add_trajectory(
        times=torch.arange(T) * 0.1,
        trajectories=[BodyTrajectory("Box", pos, quat, velocity=vel)],
        scalar_values={"energy": torch.arange(T * B).reshape(T, B).float()},
        binary=True,
    )

    out1 = tmp_path / "traj1.json"
    out2 = tmp_path / "traj2.json"
    scene.save(out1)

    loaded = SimulationScene.load(out1)
    loaded.save(out2)

    data1 = json.loads(out1.read_text())
    data2 = json.loads(out2.read_text())
    assert data1 == data2
    # Binary blob fields survived the load/save round trip intact.
    body0 = data1["states"][0]["bodies"][0]
    assert isinstance(body0["bodyTransform"], str)
    assert body0["bodyTransform"].startswith("__b64__")


# --- Gzip support (gameplan item 16) ----------------------------------------


def test_save_compress_true_writes_gzip_and_appends_suffix(tmp_path):
    scene = build_scene(batch_size=2)
    out = tmp_path / "sim.json"
    scene.save(out, compress=True)

    gz_path = tmp_path / "sim.json.gz"
    assert gz_path.is_file()
    assert not out.exists()
    with gzip.open(gz_path, "rt") as f:
        data = json.load(f)
    assert data["model"]["simBatches"] == 2


def test_save_compress_true_respects_existing_gz_suffix(tmp_path):
    scene = build_scene(batch_size=1)
    out = tmp_path / "sim.json.gz"
    scene.save(out, compress=True)

    assert out.is_file()
    with gzip.open(out, "rt") as f:
        data = json.load(f)
    assert data["model"]["simBatches"] == 1


def test_save_gz_suffix_compresses_without_compress_flag(tmp_path):
    scene = build_scene(batch_size=1)
    out = tmp_path / "sim.json.gz"
    scene.save(out)

    raw = out.read_bytes()
    assert raw[:2] == b"\x1f\x8b"  # gzip magic bytes


def test_load_reads_gzip_transparently(tmp_path):
    scene = build_scene(batch_size=2)
    plain = tmp_path / "plain.json"
    gz = tmp_path / "compressed.json.gz"
    scene.save(plain)
    scene.save(gz, compress=True)

    loaded_plain = SimulationScene.load(plain)
    loaded_gz = SimulationScene.load(gz)
    assert loaded_plain.model.to_json() == loaded_gz.model.to_json()
    assert loaded_plain.states == loaded_gz.states


def test_save_compress_load_save_equivalence(tmp_path):
    scene = build_scene(batch_size=2)
    gz1 = tmp_path / "sim1.json.gz"
    out2 = tmp_path / "sim2.json"
    scene.save(gz1, compress=True)

    loaded = SimulationScene.load(gz1)
    loaded.save(out2)

    with gzip.open(gz1, "rt") as f:
        data1 = json.load(f)
    data2 = json.loads(out2.read_text())
    assert data1 == data2


def test_scene_from_dict_matches_original_model():
    scene = build_scene(batch_size=2)
    data = {"model": scene.model.to_json(), "states": scene.states}
    loaded = SimulationScene.from_dict(data)
    assert loaded.model.to_json() == scene.model.to_json()
    assert loaded.states == scene.states


def test_invalid_heightmap_ndim_raises_value_error():
    resolution = 4
    # SimViewTerrain.create requires an explicit batch dimension (ndim == 3);
    # an outright wrong rank (4D) should trigger the ndim check directly.
    bad_heightmap = torch.zeros(1, 1, resolution, resolution)
    normals = torch.zeros(1, 3, resolution, resolution)
    with pytest.raises(ValueError, match="Heightmap must include a batch dimension"):
        SimViewTerrain.create(
            heightmap=bad_heightmap,
            normals=normals,
            x_lim=(-5, 5),
            y_lim=(-5, 5),
            is_singleton=False,
        )


def test_invalid_normals_shape_raises_value_error():
    resolution = 4
    bad_normals = torch.zeros(1, 4, resolution, resolution)  # wrong channel count
    heightmap = torch.zeros(1, resolution, resolution)
    with pytest.raises(ValueError, match="Normals must have 3 channels"):
        SimViewTerrain.create(
            heightmap=heightmap,
            normals=bad_normals,
            x_lim=(-5, 5),
            y_lim=(-5, 5),
            is_singleton=False,
        )


def test_invalid_friction_map_ndim_raises_value_error():
    resolution = 4
    heightmap = torch.zeros(1, resolution, resolution)
    normals = torch.zeros(1, 3, resolution, resolution)
    bad_friction = torch.zeros(1, 1, resolution, resolution)  # extra dim
    with pytest.raises(ValueError, match="Friction map must include a batch"):
        SimViewTerrain.create(
            heightmap=heightmap,
            normals=normals,
            x_lim=(-5, 5),
            y_lim=(-5, 5),
            is_singleton=False,
            friction_map=bad_friction,
        )
