import json

from conftest import build_scene


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
