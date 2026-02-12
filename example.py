import torch
from simview.scene import SimulationScene, BodyShapeType
from simview.state import SimViewBodyState
from simview.launcher import SimViewLauncher

# 1. Initialize the Scene
# We create a scene for 2 parallel simulations (batches)
scene = SimulationScene(batch_size=2, scalar_names=["energy"], dt=0.1)

# 2. Add Terrain
# Create a simple 100x100 wavy terrain
resolution = 100
x = torch.linspace(-5, 5, resolution)
y = torch.linspace(-5, 5, resolution)
xx, yy = torch.meshgrid(x, y, indexing="xy")
# Simple wave pattern
heights = 0.2 * torch.sin(xx) * torch.cos(yy)

# Add batch dimension (1, H, W) -> Shared terrain for all batches
height_map = heights.unsqueeze(0)

# Create normals (pointing roughly up for simplicity)
# Shape: (1, 3, H, W)
normals = torch.zeros((1, 3, resolution, resolution))
normals[:, 2, :, :] = 1.0  # Z-up

scene.create_terrain(
    heightmap=height_map, normals=normals, x_lim=(-5, 5), y_lim=(-5, 5)
)

# 3. Add a Body
# Define a "Box" body with dimensions 1x1x1
scene.create_body(body_name="Box", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5)

# 4. Add States (Animation)
# Create a simple animation where the box moves up
for t in range(50):
    time = t * 0.1

    # State for Batch 0: Moving up and rotating
    pos_b0 = torch.tensor([0.0, 0.0, time * 0.5 + 1.0])  # Start above terrain
    # Simple rotation around Z
    angle = time * 0.5
    quat_b0 = torch.tensor(
        [
            torch.cos(torch.tensor(angle / 2)),
            0.0,
            0.0,
            torch.sin(torch.tensor(angle / 2)),
        ]
    )

    # State for Batch 1: Stationary at x=2
    pos_b1 = torch.tensor([2.0, 0.0, 1.0])
    quat_b1 = torch.tensor([1.0, 0.0, 0.0, 0.0])

    # Combine batches into a single state object
    pos = torch.stack([pos_b0, pos_b1])
    quat = torch.stack([quat_b0, quat_b1])

    # Create Body State
    state = SimViewBodyState("Box", pos, quat)

    # Add the frame to the scene
    scene.add_state(
        time=time, body_states=[state], scalar_values={"energy": [10.0 - t * 0.1, 5.0]}
    )

if __name__ == "__main__":
    # Save to file
    output_file = "example_sim.json"
    scene.save(output_file)
    print(f"Simulation saved to {output_file}")

    # Launch visualization immediately:
    launcher = SimViewLauncher(scene)
    launcher.launch()
