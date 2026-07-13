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


# --- Grouped body names (name as a list) ------------------------------------


def _two_body_scene(
    batch_size: int = 1, available_attributes=("velocity",)
) -> SimulationScene:
    scene = _base_scene(
        batch_size=batch_size, available_attributes=available_attributes
    )
    scene.create_body(
        body_name="Box2",
        shape_type=BodyShapeType.BOX,
        available_attributes=list(available_attributes) or None,
        hx=0.5,
        hy=0.5,
        hz=0.5,
    )
    return scene


def test_add_state_grouped_names_shares_one_transform():
    scene = _two_body_scene(batch_size=1)
    pos = torch.zeros(1, 3)
    quat = torch.zeros(1, 4)
    quat[..., 0] = 1.0
    state = SimViewBodyState(["Box", "Box2"], pos, quat)
    scene.add_state(time=0.0, body_states=[state])

    bodies = scene.states[0]["bodies"]
    assert len(bodies) == 1
    assert bodies[0]["name"] == ["Box", "Box2"]


def test_add_state_grouped_names_unknown_body_raises():
    scene = _two_body_scene(batch_size=1)
    pos = torch.zeros(1, 3)
    quat = torch.zeros(1, 4)
    quat[..., 0] = 1.0
    state = SimViewBodyState(["Box", "Nope"], pos, quat)
    with pytest.raises(ValueError, match="Unknown body 'Nope'"):
        scene.add_state(time=0.0, body_states=[state])


def test_add_state_grouped_names_empty_list_raises():
    scene = _two_body_scene(batch_size=1)
    pos = torch.zeros(1, 3)
    quat = torch.zeros(1, 4)
    quat[..., 0] = 1.0
    state = SimViewBodyState([], pos, quat)
    with pytest.raises(ValueError, match="must not be empty"):
        scene.add_state(time=0.0, body_states=[state])


def test_add_trajectory_grouped_names_shares_one_transform():
    T, B = 3, 1
    pos = torch.randn(T, B, 3)
    quat = torch.randn(T, B, 4)
    quat = quat / quat.norm(dim=-1, keepdim=True)
    scene = _two_body_scene(batch_size=B, available_attributes=())
    scene.add_trajectory(
        times=[0.0, 0.1, 0.2],
        trajectories=[BodyTrajectory(["Box", "Box2"], pos, quat)],
    )

    for t, state in enumerate(scene.states):
        bodies = state["bodies"]
        assert len(bodies) == 1
        assert bodies[0]["name"] == ["Box", "Box2"]


def test_add_trajectory_grouped_names_unknown_body_raises():
    T, B = 2, 1
    pos = torch.zeros(T, B, 3)
    quat = torch.zeros(T, B, 4)
    quat[..., 0] = 1.0
    scene = _two_body_scene(batch_size=B)
    with pytest.raises(ValueError, match="Unknown body 'Nope'"):
        scene.add_trajectory([0.0, 0.1], [BodyTrajectory(["Box", "Nope"], pos, quat)])


def test_add_trajectory_grouped_names_with_contacts():
    """Exercises the contacts-by-name lookup, which must stay hashable when
    `name` is a list."""
    T, B = 2, 1
    pos = torch.zeros(T, B, 3)
    quat = torch.zeros(T, B, 4)
    quat[..., 0] = 1.0
    contacts = [torch.tensor([[1, 0]]), torch.tensor([[0, 1]])]
    scene = _two_body_scene(batch_size=B, available_attributes=("contacts",))
    scene.add_trajectory(
        times=[0.0, 0.1],
        trajectories=[BodyTrajectory(["Box", "Box2"], pos, quat, contacts=contacts)],
    )
    assert scene.states[0]["bodies"][0]["contacts"] == [[1, 0]]
    assert scene.states[1]["bodies"][0]["contacts"] == [[0, 1]]


def test_save_reconciles_available_attributes_for_grouped_names(tmp_path):
    scene = _two_body_scene(batch_size=1, available_attributes=())
    pos = torch.zeros(1, 3)
    quat = torch.zeros(1, 4)
    quat[..., 0] = 1.0
    vel = torch.zeros(1, 3)
    state = SimViewBodyState(["Box", "Box2"], pos, quat, {"velocity": vel})
    scene.add_state(time=0.0, body_states=[state])
    scene.save(tmp_path / "scene.json")

    assert scene.model.bodies["Box"].available_attributes == ["velocity"]
    assert scene.model.bodies["Box2"].available_attributes == ["velocity"]


# --- Parent-relative body transforms -----------------------------------------


def test_create_body_with_parent_and_local_transform_roundtrips(tmp_path):
    scene = _base_scene(batch_size=1)
    scene.create_body(
        body_name="wheel",
        shape_type=BodyShapeType.CYLINDER,
        radius=0.15,
        height=0.1,
        parent="Box",
        local_transform=[0.4, 0.52, 0.0, 1.0, 0.0, 0.0, 0.0],
    )
    scene.save(tmp_path / "scene.json")
    loaded = SimulationScene.load(tmp_path / "scene.json")

    assert loaded.model.bodies["wheel"].parent == "Box"
    assert loaded.model.bodies["wheel"].local_transform == [
        0.4,
        0.52,
        0.0,
        1.0,
        0.0,
        0.0,
        0.0,
    ]


def test_create_body_unknown_parent_raises():
    scene = _base_scene(batch_size=1)
    with pytest.raises(ValueError, match="unknown parent 'nope'"):
        scene.create_body(
            body_name="wheel",
            shape_type=BodyShapeType.BOX,
            hx=0.1,
            hy=0.1,
            hz=0.1,
            parent="nope",
        )


def test_create_body_self_parent_raises():
    scene = _base_scene(batch_size=1)
    with pytest.raises(ValueError, match="cannot be its own parent"):
        scene.create_body(
            body_name="wheel",
            shape_type=BodyShapeType.BOX,
            hx=0.1,
            hy=0.1,
            hz=0.1,
            parent="wheel",
        )


def test_create_body_parent_must_precede_child():
    """A body's parent must already exist in the model when it's added --
    this is what structurally rules out cycles without a topological sort."""
    scene = SimulationScene(batch_size=1, scalar_names=[], dt=0.1)
    with pytest.raises(ValueError, match="unknown parent 'chassis'"):
        scene.create_body(
            body_name="wheel",
            shape_type=BodyShapeType.BOX,
            hx=0.1,
            hy=0.1,
            hz=0.1,
            parent="chassis",
        )


def test_articulated_child_add_state_unaffected():
    """parent set, no local_transform: per-frame data still flows through
    add_state/add_trajectory exactly like a plain body -- the numeric
    plumbing doesn't need to know about parent-relative semantics."""
    scene = _base_scene(batch_size=1)
    scene.create_body(
        body_name="arm",
        shape_type=BodyShapeType.BOX,
        hx=0.1,
        hy=0.1,
        hz=0.1,
        parent="Box",
    )
    pos = torch.zeros(1, 3)
    quat = torch.zeros(1, 4)
    quat[..., 0] = 1.0
    scene.add_state(
        time=0.0,
        body_states=[
            SimViewBodyState("Box", pos, quat, {"velocity": torch.zeros(1, 3)}),
            SimViewBodyState("arm", pos, quat),
        ],
    )
    names = {b["name"] for b in scene.states[0]["bodies"]}
    assert names == {"Box", "arm"}


def test_rigid_body_add_state_raises():
    scene = _base_scene(batch_size=1)
    scene.create_body(
        body_name="wheel",
        shape_type=BodyShapeType.CYLINDER,
        radius=0.1,
        height=0.05,
        parent="Box",
        local_transform=[0.4, 0.52, 0.0, 1.0, 0.0, 0.0, 0.0],
    )
    pos = torch.zeros(1, 3)
    quat = torch.zeros(1, 4)
    quat[..., 0] = 1.0
    with pytest.raises(ValueError, match="rigidly attached"):
        scene.add_state(time=0.0, body_states=[SimViewBodyState("wheel", pos, quat)])


def test_rigid_body_add_trajectory_raises():
    scene = _base_scene(batch_size=1)
    scene.create_body(
        body_name="wheel",
        shape_type=BodyShapeType.CYLINDER,
        radius=0.1,
        height=0.05,
        parent="Box",
        local_transform=[0.4, 0.52, 0.0, 1.0, 0.0, 0.0, 0.0],
    )
    pos = torch.zeros(2, 1, 3)
    quat = torch.zeros(2, 1, 4)
    quat[..., 0] = 1.0
    with pytest.raises(ValueError, match="rigidly attached"):
        scene.add_trajectory([0.0, 0.1], [BodyTrajectory("wheel", pos, quat)])
