import json

import pytest
import torch
from conftest import build_scene

from simview.merge import merge_simulation_files
from simview.scene import BodyShapeType, SimulationScene
from simview.state import SimViewBodyState


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
