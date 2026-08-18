"""Generates the episodic scene the episodes e2e test runs against.

Kept separate from example.py: the demo scene is deliberately a plain
single-timeline recording, and the episode UI only appears when a scene
actually declares `episodes` (see simview/model.py::SimViewEpisode).

Run by playwright.config.js's second webServer before serving the file.
"""

from pathlib import Path

import torch

from simview import BodyShapeType, BodyTrajectory, SimulationScene

OUT = Path(__file__).parent / ".episodic_sim.json"

FRAMES_PER_EPISODE = 30
EPISODES = 4
BATCHES = 2


def main() -> None:
    scene = SimulationScene(batch_size=BATCHES, scalar_names=["reward"], dt=0.05)

    resolution = 16
    heights = torch.zeros(resolution, resolution)
    normals = torch.zeros(3, resolution, resolution)
    normals[2] = 1.0
    scene.create_terrain(
        heightmap=heights, normals=normals, x_lim=(-5, 5), y_lim=(-5, 5)
    )
    scene.create_body(
        body_name="Box", shape_type=BodyShapeType.BOX, hx=0.3, hy=0.3, hz=0.3
    )

    steps = torch.arange(FRAMES_PER_EPISODE).float()
    for episode in range(EPISODES):
        # Marked before the episode's frames are added, which is what
        # mark_episode()'s default start_index means.
        scene.mark_episode(label=f"episode {episode + 1}")

        pos = torch.zeros(FRAMES_PER_EPISODE, BATCHES, 3)
        pos[:, :, 0] = (steps / FRAMES_PER_EPISODE * 4 - 2)[:, None]
        pos[:, :, 2] = 0.5 + 0.3 * torch.sin(steps / 5)[:, None]
        quat = torch.zeros(FRAMES_PER_EPISODE, BATCHES, 4)
        quat[..., 0] = 1.0
        # A per-episode reward ramp, so the plotter's per-episode aggregates
        # differ between episodes rather than all coming out identical.
        reward = (steps[:, None] * (episode + 1) / FRAMES_PER_EPISODE).repeat(1, BATCHES)

        offset = episode * FRAMES_PER_EPISODE
        scene.add_trajectory(
            times=(torch.arange(FRAMES_PER_EPISODE) + offset) * 0.05,
            trajectories=[BodyTrajectory("Box", pos, quat)],
            scalar_values={"reward": reward},
        )

    scene.save(OUT)
    print(f"Wrote {OUT} ({EPISODES} episodes, {len(scene.states)} frames)")


if __name__ == "__main__":
    main()
