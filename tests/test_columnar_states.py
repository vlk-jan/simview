"""Tests for the server's columnar states repack (wire format v4).

See README.md "Binary state fields" and simview/server.py::_columnarize_states.
The on-disk JSON format and merge.py are unaffected -- this only covers the
repack the server does at load time before serving `/states`.
"""

import pytest

pytest.importorskip("torch")

import numpy as np
import torch
from fastapi.testclient import TestClient

from simview.scene import BodyShapeType, SimulationScene
from simview.server import SimViewServer
from simview.state import BodyTrajectory, SimViewBodyState


def _make_scene(batch_size: int, scalar_names=None) -> SimulationScene:
    scene = SimulationScene(
        batch_size=batch_size, scalar_names=scalar_names or [], dt=0.1
    )
    resolution = 4
    heights = torch.zeros(resolution, resolution)
    normals = torch.zeros(3, resolution, resolution)
    normals[2] = 1.0
    scene.create_terrain(
        heightmap=heights, normals=normals, x_lim=(-5, 5), y_lim=(-5, 5)
    )
    return scene


def _client_for(scene: SimulationScene, tmp_path, name="sim.json") -> TestClient:
    sim_file = tmp_path / name
    scene.save(sim_file)
    server = SimViewServer(sim_path=sim_file)
    return TestClient(server.app)


def _fetch_blob_f4(client: TestClient, url: str, shape) -> np.ndarray:
    resp = client.get(url)
    assert resp.status_code == 200
    return np.frombuffer(resp.content, dtype="<f4").reshape(shape)


# --- (a) add_trajectory(binary=True) columnarizes; blobs decode to the originals ---


def test_binary_trajectory_columnarizes_and_blobs_match(tmp_path):
    T, B = 6, 2
    torch.manual_seed(0)
    scene = _make_scene(batch_size=B)
    scene.create_body(
        body_name="Box",
        shape_type=BodyShapeType.BOX,
        available_attributes=["velocity"],
        hx=0.5,
        hy=0.5,
        hz=0.5,
    )
    pos = torch.randn(T, B, 3)
    quat = torch.randn(T, B, 4)
    quat = quat / quat.norm(dim=-1, keepdim=True)
    vel = torch.randn(T, B, 3)
    times = [t * 0.1 for t in range(T)]
    scene.add_trajectory(
        times=times,
        trajectories=[BodyTrajectory("Box", pos, quat, velocity=vel)],
        binary=True,
    )

    client = _client_for(scene, tmp_path)
    body = client.get("/states").json()

    assert body["version"] == 4
    assert body["times"] == pytest.approx(times)
    assert len(body["bodies"]) == 1
    b = body["bodies"][0]
    assert b["name"] == "Box"
    assert "contacts" not in b

    transform = _fetch_blob_f4(client, b["fields"]["bodyTransform"], (T, B, 7))
    expected_transform = torch.cat([pos, quat], dim=-1).numpy()
    np.testing.assert_allclose(transform, expected_transform, atol=1e-6)

    velocity = _fetch_blob_f4(client, b["fields"]["velocity"], (T, B, 3))
    np.testing.assert_allclose(velocity, vel.numpy(), atol=1e-6)


# --- (b) plain-JSON (binary=False) scenes are also columnarized -------------------


def test_plain_json_trajectory_columnarizes_too(tmp_path):
    T, B = 4, 3
    torch.manual_seed(1)
    scene = _make_scene(batch_size=B)
    scene.create_body(
        body_name="Box", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5
    )
    pos = torch.randn(T, B, 3)
    quat = torch.randn(T, B, 4)
    quat = quat / quat.norm(dim=-1, keepdim=True)
    times = [t * 0.05 for t in range(T)]
    scene.add_trajectory(
        times=times,
        trajectories=[BodyTrajectory("Box", pos, quat)],
        binary=False,
    )
    # Confirm the on-disk states really are plain JSON lists, not blobs.
    assert isinstance(scene.states[0]["bodies"][0]["bodyTransform"], list)

    client = _client_for(scene, tmp_path)
    body = client.get("/states").json()
    assert body["version"] == 4

    b = body["bodies"][0]
    transform = _fetch_blob_f4(client, b["fields"]["bodyTransform"], (T, B, 7))
    expected = torch.cat([pos, quat], dim=-1).numpy()
    np.testing.assert_allclose(transform, expected, atol=1e-6)


# --- single-batch flat (non-nested) bodyTransform reshapes to (1, 7) --------------


def test_single_batch_flat_transform_reshapes(tmp_path):
    scene = _make_scene(batch_size=1)
    scene.create_body(
        body_name="Box", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5
    )
    for t in range(3):
        pos = torch.tensor([0.0, 0.0, float(t)])
        quat = torch.tensor([1.0, 0.0, 0.0, 0.0])
        state = SimViewBodyState("Box", pos, quat, binary=False)
        scene.add_state(time=t * 0.1, body_states=[state])
    # add_state with a single batch produces a flat (non-nested) bodyTransform.
    assert not isinstance(scene.states[0]["bodies"][0]["bodyTransform"][0], list)

    client = _client_for(scene, tmp_path)
    body = client.get("/states").json()
    assert body["version"] == 4
    b = body["bodies"][0]
    transform = _fetch_blob_f4(client, b["fields"]["bodyTransform"], (3, 1, 7))
    for t in range(3):
        assert transform[t, 0, 2] == pytest.approx(float(t))


# --- (c) contacts survive per-frame, null when absent -----------------------------


def test_contacts_survive_with_null_for_missing_frames(tmp_path):
    scene = _make_scene(batch_size=1)
    scene.create_body(
        body_name="Box",
        shape_type=BodyShapeType.BOX,
        available_attributes=["contacts"],
        hx=0.5,
        hy=0.5,
        hz=0.5,
    )
    contacts_by_t = [[[0, 1]], None, [[2]]]
    for t in range(3):
        pos = torch.tensor([[0.0, 0.0, float(t)]])
        quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]])
        attrs = {}
        if contacts_by_t[t] is not None:
            attrs["contacts"] = contacts_by_t[t]
        state = SimViewBodyState("Box", pos, quat, attrs)
        scene.add_state(time=t * 0.1, body_states=[state])

    client = _client_for(scene, tmp_path)
    body = client.get("/states").json()
    assert body["version"] == 4
    b = body["bodies"][0]
    assert b["contacts"] == [[[0, 1]], None, [[2]]]


def test_contacts_backfill_null_before_first_appearance(tmp_path):
    # Contacts may legitimately not appear until partway through a trajectory
    # (e.g. a body only starts touching the ground later); earlier frames
    # must backfill with None rather than being omitted or misaligned.
    scene = _make_scene(batch_size=1)
    scene.create_body(
        body_name="Box",
        shape_type=BodyShapeType.BOX,
        available_attributes=["contacts"],
        hx=0.5,
        hy=0.5,
        hz=0.5,
    )
    contacts_by_t = [None, None, [[0, 1]], [[2]]]
    for t in range(4):
        pos = torch.tensor([[0.0, 0.0, float(t)]])
        quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]])
        attrs = {}
        if contacts_by_t[t] is not None:
            attrs["contacts"] = contacts_by_t[t]
        state = SimViewBodyState("Box", pos, quat, attrs)
        scene.add_state(time=t * 0.1, body_states=[state])

    client = _client_for(scene, tmp_path)
    body = client.get("/states").json()
    assert body["version"] == 4
    assert body["bodies"][0]["contacts"] == [None, None, [[0, 1]], [[2]]]


# --- (d) scalars decode to the original (T, B) -------------------------------------


def test_scalars_columnarize_to_original_values(tmp_path):
    T, B = 5, 2
    scene = _make_scene(batch_size=B, scalar_names=["energy"])
    scene.create_body(
        body_name="Box", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5
    )
    energy = torch.arange(T * B, dtype=torch.float32).reshape(T, B)
    pos = torch.zeros(T, B, 3)
    quat = torch.zeros(T, B, 4)
    quat[..., 0] = 1.0
    times = [t * 0.1 for t in range(T)]
    scene.add_trajectory(
        times=times,
        trajectories=[BodyTrajectory("Box", pos, quat)],
        scalar_values={"energy": energy},
    )

    client = _client_for(scene, tmp_path)
    body = client.get("/states").json()
    assert body["version"] == 4
    url = body["scalars"]["energy"]
    values = _fetch_blob_f4(client, url, (T, B))
    np.testing.assert_allclose(values, energy.numpy())


# --- (e) inconsistent states (body present only in some frames) falls back --------


def test_inconsistent_body_presence_falls_back_to_legacy_array(tmp_path):
    scene = _make_scene(batch_size=1)
    scene.create_body(
        body_name="A", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5
    )
    scene.create_body(
        body_name="B", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5
    )
    for t in range(3):
        pos = torch.tensor([[0.0, 0.0, float(t)]])
        quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]])
        states = [SimViewBodyState("A", pos, quat)]
        if t != 1:  # 'B' is missing from the middle frame
            states.append(SimViewBodyState("B", pos, quat))
        scene.add_state(time=t * 0.1, body_states=states)

    client = _client_for(scene, tmp_path)
    resp = client.get("/states")
    body = resp.json()
    assert isinstance(body, list)
    assert len(body) == 3


# --- (f) grouped body names (name as list) work ------------------------------------


def test_grouped_body_names_columnarize(tmp_path):
    scene = _make_scene(batch_size=1)
    scene.create_body(
        body_name="A", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5
    )
    scene.create_body(
        body_name="B", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5
    )
    for t in range(3):
        pos = torch.tensor([[0.0, 0.0, float(t)]])
        quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]])
        state = SimViewBodyState(["A", "B"], pos, quat)
        scene.add_state(time=t * 0.1, body_states=[state])

    client = _client_for(scene, tmp_path)
    body = client.get("/states").json()
    assert body["version"] == 4
    assert len(body["bodies"]) == 1
    assert body["bodies"][0]["name"] == ["A", "B"]
    transform = _fetch_blob_f4(
        client, body["bodies"][0]["fields"]["bodyTransform"], (3, 1, 7)
    )
    for t in range(3):
        assert transform[t, 0, 2] == pytest.approx(float(t))
