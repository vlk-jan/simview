import torch

from simview.scene import BodyShapeType, SimulationScene
from simview.state import SimViewBodyState


def build_scene(batch_size: int = 2) -> SimulationScene:
    """A small but representative scene: shared terrain, one box, a few states."""
    scene = SimulationScene(batch_size=batch_size, scalar_names=["energy"], dt=0.1)

    resolution = 4
    heights = torch.zeros(resolution, resolution)
    normals = torch.zeros(3, resolution, resolution)
    normals[2] = 1.0
    friction = torch.full((resolution, resolution), 0.5)
    stiffness = torch.full((resolution, resolution), 250000.0)
    scene.create_terrain(
        heightmap=heights,
        normals=normals,
        x_lim=(-5, 5),
        y_lim=(-5, 5),
        friction_map=friction,
        stiffness_map=stiffness,
    )

    scene.create_body(
        body_name="Box",
        shape_type=BodyShapeType.BOX,
        available_attributes=["velocity"],
        hx=0.5,
        hy=0.5,
        hz=0.5,
    )

    for t in range(3):
        pos = torch.tensor([[0.0, 0.0, float(t)]] * batch_size)
        quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]] * batch_size)
        vel = torch.zeros(batch_size, 3)
        state = SimViewBodyState("Box", pos, quat, {"velocity": vel})
        scene.add_state(
            time=t * 0.1,
            body_states=[state],
            scalar_values={"energy": [1.0] * batch_size},
        )

    return scene
