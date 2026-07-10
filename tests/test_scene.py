"""Tests for body-name validation, numpy authoring, contacts in add_trajectory,
and _clear_internal_data."""

import pytest

torch = pytest.importorskip("torch")
np = pytest.importorskip("numpy")

from conftest import build_scene

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


# --- Body name validation (gameplan item 14) --------------------------------


def test_add_state_unknown_body_raises():
    scene = _base_scene(batch_size=1)
    pos = torch.zeros(1, 3)
    quat = torch.zeros(1, 4)
    quat[..., 0] = 1.0
    state = SimViewBodyState("Nope", pos, quat)
    with pytest.raises(ValueError, match="Unknown body 'Nope'"):
        scene.add_state(time=0.0, body_states=[state])


def test_add_state_unknown_body_message_lists_valid_names():
    scene = _base_scene(batch_size=1)
    pos = torch.zeros(1, 3)
    quat = torch.zeros(1, 4)
    quat[..., 0] = 1.0
    state = SimViewBodyState("Typo", pos, quat)
    with pytest.raises(ValueError, match=r"Box"):
        scene.add_state(time=0.0, body_states=[state])


def test_add_trajectory_unknown_body_raises():
    scene = _base_scene(batch_size=1)
    pos = torch.zeros(2, 1, 3)
    quat = torch.zeros(2, 1, 4)
    quat[..., 0] = 1.0
    with pytest.raises(ValueError, match="Unknown body 'Nope'"):
        scene.add_trajectory([0.0, 0.1], [BodyTrajectory("Nope", pos, quat)])


# --- Numpy-only authoring (gameplan item 15) --------------------------------


def test_add_trajectory_numpy_matches_torch():
    T, B = 4, 2
    rng = np.random.default_rng(0)
    pos_np = rng.standard_normal((T, B, 3)).astype(np.float32)
    quat_np = rng.standard_normal((T, B, 4)).astype(np.float32)
    quat_np = quat_np / np.linalg.norm(quat_np, axis=-1, keepdims=True)
    vel_np = rng.standard_normal((T, B, 3)).astype(np.float32)

    pos_t, quat_t, vel_t = (
        torch.from_numpy(pos_np),
        torch.from_numpy(quat_np),
        torch.from_numpy(vel_np),
    )

    np_scene = _base_scene(batch_size=B)
    np_scene.add_trajectory(
        times=[0.0, 0.1, 0.2, 0.3],
        trajectories=[BodyTrajectory("Box", pos_np, quat_np, velocity=vel_np)],
    )

    torch_scene = _base_scene(batch_size=B)
    torch_scene.add_trajectory(
        times=[0.0, 0.1, 0.2, 0.3],
        trajectories=[BodyTrajectory("Box", pos_t, quat_t, velocity=vel_t)],
    )

    assert np_scene.states == torch_scene.states


def test_add_trajectory_numpy_times_and_scalars():
    T, B = 3, 1
    pos = np.zeros((T, B, 3), dtype=np.float32)
    quat = np.zeros((T, B, 4), dtype=np.float32)
    quat[..., 0] = 1.0
    scene = _base_scene(batch_size=B, scalar_names=["energy"])
    scene.add_trajectory(
        times=np.array([0.0, 0.1, 0.2]),
        trajectories=[BodyTrajectory("Box", pos, quat)],
        scalar_values={"energy": np.arange(T * B).reshape(T, B).astype(np.float32)},
    )
    assert [s["time"] for s in scene.states] == [0.0, 0.1, 0.2]
    assert scene.states[1]["energy"] == [1.0]


def test_add_state_numpy_position_orientation_and_velocity():
    pos = np.array([[1.0, 2.0, 3.0]], dtype=np.float32)
    quat = np.array([[1.0, 0.0, 0.0, 0.0]], dtype=np.float32)
    vel = np.array([[0.1, 0.2, 0.3]], dtype=np.float32)
    state = SimViewBodyState("Box", pos, quat, {"velocity": vel})
    body = state.to_json()
    assert np.array(body["bodyTransform"]) == pytest.approx(
        np.array([[1.0, 2.0, 3.0, 1.0, 0.0, 0.0, 0.0]])
    )
    assert np.array(body["velocity"]) == pytest.approx(np.array([[0.1, 0.2, 0.3]]))


# --- _clear_internal_data leak (bug B3) -------------------------------------


def test_clear_internal_data_clears_friction_and_stiffness():
    scene = build_scene(batch_size=2)
    terrain = scene.model.terrain
    assert terrain.friction_data is not None
    assert terrain.stiffness_data is not None

    scene._clear_internal_data()

    assert scene.states == []
    assert terrain.height_data == []
    assert terrain.normals == []
    assert terrain.friction_data is None
    assert terrain.stiffness_data is None


# --- Contacts in add_trajectory (bug B4) ------------------------------------


def test_add_trajectory_contacts_matches_add_state():
    T, B = 3, 2
    torch.manual_seed(0)
    pos = torch.randn(T, B, 3)
    quat = torch.randn(T, B, 4)
    quat = quat / quat.norm(dim=-1, keepdim=True)
    contact_masks = [
        torch.tensor([[1, 0, 1], [0, 0, 0]]),
        torch.tensor([[0, 1, 0], [1, 1, 1]]),
        torch.tensor([[0, 0, 0], [0, 0, 1]]),
    ]

    scene = _base_scene(batch_size=B, available_attributes=("velocity", "contacts"))
    scene.add_trajectory(
        times=[0.0, 0.1, 0.2],
        trajectories=[
            BodyTrajectory("Box", pos, quat, contacts=contact_masks),
        ],
    )

    per_frame = _base_scene(batch_size=B, available_attributes=("velocity", "contacts"))
    for t in range(T):
        state = SimViewBodyState("Box", pos[t], quat[t], {"contacts": contact_masks[t]})
        per_frame.add_state(time=t * 0.1, body_states=[state])

    for t in range(T):
        assert (
            scene.states[t]["bodies"][0]["contacts"]
            == (per_frame.states[t]["bodies"][0]["contacts"])
        )


def test_add_trajectory_without_contacts_omits_key():
    T, B = 2, 1
    pos = torch.zeros(T, B, 3)
    quat = torch.zeros(T, B, 4)
    quat[..., 0] = 1.0
    scene = _base_scene(batch_size=B)
    scene.add_trajectory(
        times=[0.0, 0.1], trajectories=[BodyTrajectory("Box", pos, quat)]
    )
    assert "contacts" not in scene.states[0]["bodies"][0]


def test_add_trajectory_contacts_wrong_length_raises():
    T, B = 3, 1
    pos = torch.zeros(T, B, 3)
    quat = torch.zeros(T, B, 4)
    quat[..., 0] = 1.0
    contacts = [torch.tensor([[1, 0]]), torch.tensor([[0, 1]])]  # only 2, need 3
    scene = _base_scene(batch_size=B, available_attributes=("contacts",))
    with pytest.raises(ValueError, match="contacts has 2 timesteps"):
        scene.add_trajectory(
            times=[0.0, 0.1, 0.2],
            trajectories=[BodyTrajectory("Box", pos, quat, contacts=contacts)],
        )
