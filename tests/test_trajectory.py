"""Tests for the batched add_trajectory API and its binary state encoding."""

import base64
import struct

import pytest

torch = pytest.importorskip("torch")

from simview.merge import merge_simulation_files
from simview.scene import BodyShapeType, SimulationScene
from simview.state import BodyTrajectory, SimViewBodyState


def _base_scene(
    batch_size: int = 2, scalar_names=None, available_attributes=("velocity",)
) -> SimulationScene:
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
    scene.create_body(
        body_name="Box",
        shape_type=BodyShapeType.BOX,
        available_attributes=list(available_attributes) or None,
        hx=0.5,
        hy=0.5,
        hz=0.5,
    )
    return scene


def _decode_blob(value: str, width: int) -> list[list[float]]:
    assert value.startswith("__b64__")
    raw = base64.b64decode(value[7:])
    flat = struct.unpack(f"<{len(raw) // 4}f", raw)
    return [list(flat[i : i + width]) for i in range(0, len(flat), width)]


def _make_trajectory(T: int, B: int):
    torch.manual_seed(0)
    pos = torch.randn(T, B, 3)
    # Normalized quaternions, [w, x, y, z].
    quat = torch.randn(T, B, 4)
    quat = quat / quat.norm(dim=-1, keepdim=True)
    vel = torch.randn(T, B, 3)
    return pos, quat, vel


def test_binary_state_fields_are_encoded_and_decode_back():
    T, B = 5, 2
    pos, quat, vel = _make_trajectory(T, B)
    scene = _base_scene(batch_size=B, scalar_names=["energy"])
    scene.add_trajectory(
        times=torch.arange(T) * 0.1,
        trajectories=[BodyTrajectory("Box", pos, quat, velocity=vel)],
        scalar_values={"energy": torch.arange(T * B).reshape(T, B).float()},
    )

    assert len(scene.states) == T
    state = scene.states[2]
    body = state["bodies"][0]
    # bodyTransform and velocity are binary blobs; scalars/time stay plain JSON.
    assert isinstance(body["bodyTransform"], str)
    assert isinstance(body["velocity"], str)
    assert isinstance(state["energy"], list)

    transform = _decode_blob(body["bodyTransform"], 7)
    expected = torch.cat([pos[2], quat[2]], dim=-1)
    assert torch.allclose(torch.tensor(transform), expected, atol=1e-6)

    velocity = _decode_blob(body["velocity"], 3)
    assert torch.allclose(torch.tensor(velocity), vel[2], atol=1e-6)


def test_binary_matches_json_and_matches_add_state():
    T, B = 4, 2
    pos, quat, vel = _make_trajectory(T, B)
    times = [0.0, 0.1, 0.2, 0.3]

    binary = _base_scene(batch_size=B)
    binary.add_trajectory(
        times, [BodyTrajectory("Box", pos, quat, velocity=vel)], binary=True
    )
    plain = _base_scene(batch_size=B)
    plain.add_trajectory(
        times, [BodyTrajectory("Box", pos, quat, velocity=vel)], binary=False
    )
    per_frame = _base_scene(batch_size=B)
    for t in range(T):
        state = SimViewBodyState("Box", pos[t], quat[t], {"velocity": vel[t]})
        per_frame.add_state(time=times[t], body_states=[state])

    for t in range(T):
        pb = plain.states[t]["bodies"][0]
        fb = per_frame.states[t]["bodies"][0]
        bb = binary.states[t]["bodies"][0]
        # JSON path equals the classic per-frame add_state output.
        assert torch.allclose(
            torch.tensor(pb["bodyTransform"]),
            torch.tensor(fb["bodyTransform"]),
            atol=1e-6,
        )
        # Binary path decodes to the same values.
        assert torch.allclose(
            torch.tensor(_decode_blob(bb["bodyTransform"], 7)),
            torch.tensor(pb["bodyTransform"]),
            atol=1e-6,
        )


def test_single_batch_accepts_2d_shapes():
    T = 3
    pos = torch.randn(T, 3)
    quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]]).repeat(T, 1)
    scene = _base_scene(batch_size=1)
    scene.add_trajectory([0.0, 0.1, 0.2], [BodyTrajectory("Box", pos, quat)])
    transform = _decode_blob(scene.states[0]["bodies"][0]["bodyTransform"], 7)
    assert len(transform) == 1  # one batch row
    assert transform[0][:3] == pytest.approx(pos[0].tolist(), abs=1e-6)


def test_unknown_body_raises():
    scene = _base_scene(batch_size=1)
    pos = torch.zeros(2, 1, 3)
    quat = torch.zeros(2, 1, 4)
    quat[..., 0] = 1.0
    with pytest.raises(ValueError, match="Unknown body"):
        scene.add_trajectory([0.0, 0.1], [BodyTrajectory("Nope", pos, quat)])


def test_wrong_batch_dim_raises():
    scene = _base_scene(batch_size=2)
    pos = torch.zeros(2, 3, 3)  # batch 3 != scene batch 2
    quat = torch.zeros(2, 3, 4)
    quat[..., 0] = 1.0
    with pytest.raises(ValueError, match="batch dim"):
        scene.add_trajectory([0.0, 0.1], [BodyTrajectory("Box", pos, quat)])


def test_merge_decodes_binary_files(tmp_path):
    T, B = 3, 1
    pos, quat, _ = _make_trajectory(T, B)

    def build(tag):
        scene = _base_scene(batch_size=B, available_attributes=())
        scene.add_trajectory(
            [0.0, 0.1, 0.2], [BodyTrajectory("Box", pos + tag, quat)], binary=True
        )
        path = tmp_path / f"{tag}.json"
        scene.save(path)
        return path

    merged = merge_simulation_files([build(0.0), build(1.0)])
    assert merged["model"]["simBatches"] == 2
    # Merge output is decoded to plain nested lists (not binary strings).
    transform = merged["states"][0]["bodies"][0]["bodyTransform"]
    assert isinstance(transform, list) and len(transform) == 2
    assert transform[0][:3] == pytest.approx(pos[0, 0].tolist(), abs=1e-6)
    assert transform[1][0] == pytest.approx(pos[0, 0, 0].item() + 1.0, abs=1e-6)
