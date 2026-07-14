"""Demonstrates live streaming mode: instead of building the whole simulation
up front and saving/viewing it afterwards (see example.py), this script opens
a LiveViewer as soon as the scene's model (terrain + bodies) is ready, then
pushes ~200 states to it one at a time, paced with time.sleep(dt) to mimic a
simulation loop producing frames in real time. Reload the page (or open a
second tab) partway through to see the catch-up + live-follow behavior.

Set SIMVIEW_EXAMPLE_HEADLESS=1 to skip opening a browser tab (used by the
manual verification step in CI-less environments / this repo's own checks).
"""

import os
import time

import torch

from simview.live import LiveViewer
from simview.scene import BodyShapeType, SimulationScene
from simview.state import SimViewBodyState

# 1. Build the scene's model up front, exactly like example.py -- only states
# are streamed incrementally; terrain/bodies must already be complete before
# LiveViewer starts serving.
scene = SimulationScene(batch_size=2, scalar_names=["energy"], dt=0.1)

resolution = 100
x = torch.linspace(-5, 5, resolution)
y = torch.linspace(-5, 5, resolution)
xx, yy = torch.meshgrid(x, y, indexing="xy")
heights = 0.2 * torch.sin(xx) * torch.cos(yy)
height_map = heights.unsqueeze(0)

normals = torch.zeros((1, 3, resolution, resolution))
normals[:, 2, :, :] = 1.0  # Z-up

scene.create_terrain(
    heightmap=height_map, normals=normals, x_lim=(-5, 5), y_lim=(-5, 5)
)

scene.create_body(body_name="Box", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5)

if __name__ == "__main__":
    num_steps = 200
    dt = 0.1
    headless = os.environ.get("SIMVIEW_EXAMPLE_HEADLESS") == "1"

    # 2. Open the viewer now, before any states exist -- the browser tab
    # connects immediately and shows "waiting for first state" until push_state
    # below starts arriving.
    with LiveViewer(scene, open_browser=not headless) as live:
        print(f"Live viewer running on http://127.0.0.1:{live.port}")
        for t in range(num_steps):
            sim_time = t * dt

            pos_b0 = torch.tensor([0.0, 0.0, sim_time * 0.5 + 1.0])
            angle = sim_time * 0.5
            quat_b0 = torch.tensor(
                [
                    torch.cos(torch.tensor(angle / 2)),
                    0.0,
                    0.0,
                    torch.sin(torch.tensor(angle / 2)),
                ]
            )

            pos_b1 = torch.tensor([2.0, 0.0, 1.0])
            quat_b1 = torch.tensor([1.0, 0.0, 0.0, 0.0])

            pos = torch.stack([pos_b0, pos_b1])
            quat = torch.stack([quat_b0, quat_b1])

            state = SimViewBodyState("Box", pos, quat)
            live.push_state(
                time=sim_time,
                body_states=[state],
                scalar_values={"energy": [10.0 - t * 0.1, 5.0]},
            )
            time.sleep(dt)

        print("Streaming finished. Scene can still be saved normally:")
        scene.save("example_live_sim.json")
        print("Saved to example_live_sim.json")
