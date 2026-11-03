"""Generates the single-frame scene the static-playback e2e test runs against.

Run by playwright.config.js's third webServer before serving the file.
"""

from pathlib import Path

import torch

from simview import BodyShapeType, SimulationScene
from simview.state import SimViewBodyState

OUT = Path(__file__).parent / ".static_sim.json"


def main() -> None:
    scene = SimulationScene(batch_size=1, scalar_names=[], dt=0.1)
    normals = torch.zeros(3, 8, 8)
    normals[2] = 1.0
    scene.create_terrain(
        heightmap=torch.zeros(8, 8), normals=normals, x_lim=(-3, 3), y_lim=(-3, 3)
    )
    scene.create_body(
        body_name="Box", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5
    )
    pose = SimViewBodyState(
        "Box", torch.tensor([[0.0, 0.0, 0.5]]), torch.tensor([[1.0, 0.0, 0.0, 0.0]])
    )
    scene.add_state(time=0.0, body_states=[pose])
    scene.save(OUT)
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
