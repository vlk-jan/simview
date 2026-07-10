"""Tests for terrain batch/singleton handling in create_terrain."""

import base64
import json
import struct

import pytest

torch = pytest.importorskip("torch")

from fastapi.testclient import TestClient

from simview.merge import merge_simulation_files
from simview.scene import BodyShapeType, SimulationScene
from simview.server import SimViewServer
from simview.state import SimViewBodyState


def _flat(blob: str) -> list[float]:
    assert blob.startswith("__b64__")
    raw = base64.b64decode(blob[7:])
    return list(struct.unpack(f"<{len(raw) // 4}f", raw))


def _terrain(batch_size, h_batches, n_batches):
    res = 3
    scene = SimulationScene(batch_size=batch_size, scalar_names=[], dt=0.1)
    heights = torch.arange(h_batches * res * res, dtype=torch.float32).reshape(
        h_batches, res, res
    )
    normals = torch.zeros(n_batches, 3, res, res)
    normals[:, 2] = 1.0
    scene.create_terrain(
        heightmap=heights, normals=normals, x_lim=(-1, 1), y_lim=(-1, 1)
    )
    return scene.model.terrain, res


def _per_batch_scene(batch_size: int, offset: float = 0.0) -> SimulationScene:
    """A scene whose terrain heightmap/normals differ per batch (non-singleton),
    used for save -> merge/serve end-to-end coverage. `offset` shifts every
    height value so rows built by two different calls are never accidentally
    identical (e.g. batch 0 of one scene vs. batch 0 of another)."""
    res = 3
    scene = SimulationScene(batch_size=batch_size, scalar_names=[], dt=0.1)
    heights = offset + torch.arange(
        batch_size * res * res, dtype=torch.float32
    ).reshape(batch_size, res, res)
    normals = torch.zeros(batch_size, 3, res, res)
    normals[:, 2] = 1.0
    scene.create_terrain(
        heightmap=heights, normals=normals, x_lim=(-1, 1), y_lim=(-1, 1)
    )
    scene.create_body(
        body_name="Box", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5
    )
    for t in range(2):
        pos = torch.tensor([[0.0, 0.0, float(t)]] * batch_size)
        quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]] * batch_size)
        scene.add_state(time=t * 0.1, body_states=[SimViewBodyState("Box", pos, quat)])
    return scene


def test_shared_terrain_is_singleton_and_broadcast():
    terrain, res = _terrain(batch_size=3, h_batches=1, n_batches=1)
    assert terrain.is_singleton is True
    # Broadcast to batch_size so the viewer (which splits by batch_size) is happy.
    assert len(_flat(terrain.height_data)) == 3 * res * res


def test_mixed_shared_and_per_batch_is_not_singleton():
    # Shared height (1) + per-batch normals (3): previously this was mislabeled
    # singleton; now it's a consistent non-singleton with height broadcast.
    terrain, res = _terrain(batch_size=3, h_batches=1, n_batches=3)
    assert terrain.is_singleton is False
    assert len(_flat(terrain.height_data)) == 3 * res * res
    assert len(_flat(terrain.normals)) == 3 * res * res * 3


def test_per_batch_terrain_is_not_singleton():
    terrain, _ = _terrain(batch_size=2, h_batches=2, n_batches=2)
    assert terrain.is_singleton is False


def test_single_batch_is_not_singleton():
    terrain, _ = _terrain(batch_size=1, h_batches=1, n_batches=1)
    assert terrain.is_singleton is False


def test_invalid_batch_dim_raises():
    with pytest.raises(ValueError, match="batch dim"):
        _terrain(batch_size=3, h_batches=2, n_batches=3)  # 2 is neither 1 nor 3


# --- Per-batch (non-singleton) terrain, end-to-end ---------------------------


def test_per_batch_terrain_save_load_roundtrip(tmp_path):
    scene = _per_batch_scene(batch_size=3)
    assert scene.model.terrain.is_singleton is False

    out = tmp_path / "sim.json"
    scene.save(out)
    data = json.loads(out.read_text())
    assert data["model"]["terrain"]["isSingleton"] is False

    loaded = SimulationScene.load(out)
    assert loaded.model.terrain.is_singleton is False
    assert loaded.model.terrain.height_data == scene.model.terrain.height_data


def test_per_batch_terrain_merges_across_files(tmp_path):
    scene_a = _per_batch_scene(batch_size=2)
    scene_b = _per_batch_scene(batch_size=3, offset=1000.0)
    path_a, path_b = tmp_path / "a.json", tmp_path / "b.json"
    scene_a.save(path_a)
    scene_b.save(path_b)

    merged = merge_simulation_files([path_a, path_b])

    assert merged["model"]["simBatches"] == 5
    height = merged["model"]["terrain"]["heightData"]
    assert len(height) == 5
    # Each batch's per-batch terrain row is distinct (heights were built with
    # torch.arange, so no two batches share a row) -- confirms rows weren't
    # collapsed/broadcast as if singleton.
    flattened = [tuple(row) for row in height]
    assert len(set(flattened)) == 5


def test_per_batch_terrain_served_by_server(tmp_path):
    scene = _per_batch_scene(batch_size=3)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    server = SimViewServer(sim_path=sim_file)
    client = TestClient(server.app)

    model = client.get("/model").json()
    assert model["simBatches"] == 3
    assert model["terrain"]["isSingleton"] is False
    # The server extracts __b64__ blobs into separate /blob/{id} binary
    # responses, replacing the field with a "/blob/{id}" reference string.
    height_ref = model["terrain"]["heightData"]
    assert height_ref.startswith("/blob/")
    blob_resp = client.get(height_ref)
    assert blob_resp.status_code == 200
    floats = struct.unpack(f"<{len(blob_resp.content) // 4}f", blob_resp.content)
    assert len(floats) == 3 * 3 * 3  # batch * res * res
    assert len(client.get("/states").json()) == 2
