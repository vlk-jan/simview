# SimView Visualizer

**SimView** is a powerful and interactive tool for visualizing 3D models and terrain data in simulations. It enables you to explore and analyze multiple simulation scenarios (batches) within a shared environment, all defined through an intuitive JSON format or a Python API.

Whether you're simulating physical objects or comparing different runs, SimView provides a flexible and efficient way to bring your data to life using a web-based interface powered by Three.js.

---

## Features

- **Batched Simulations**: Visualize multiple simulation instances side-by-side.
- **Shared Terrain**: Efficient rendering with shared terrain across all batches.
- **Interactive UI**: Web-based controls for playback, camera, and data inspection.
- **Python API**: Easy-to-use API for generating scenes and launching the visualizer directly from your code.
- **JSON Support**: Load and save simulation data using a portable JSON format.

---

## Installation

You can install SimView directly from the source:

```bash
pip install -e .
```

For independent use of this repository, use `venv` or `uv`:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

```bash
uv sync
source .venv/bin/activate
```

---

## CLI Utilities

### Cache Management

SimView caches some temporary files for visualization. You can clear this cache using the following command:

```bash
simview clear
```

### Visualization of exported simulations

To visualize a simulation defined in a JSON file, run the following command, replacing `[path_to_json_file]` with the actual path to your JSON data:

```bash
simview [path_to_json_file]
```

---

## Visualization Controls

Once the visualizer is running, you can interact with the simulation using the following controls:

### Camera

- **Rotate**: Left-click + drag OR `Ctrl` (`CMD` on Mac) + Arrow keys
- **Pan**: Right-click + drag OR Arrow keys
- **Zoom**: Scroll wheel

### Timeline

- **Step Forward/Backward**: `Alt` + Arrow Right / Arrow Left
- **Seek (and Pause)**: Click on the timeline bar
- **Play/Pause**: `Space` or Click the Play button
- **Record**: `R` or Click the Record button

### Batch Selection

- **Move Selection**: `Shift` + Arrow keys

### Visualization Options

- **`B`**: Toggle Body Visualization Mode (Mesh / Wireframe / Points)
- **`A`**: Toggle Axes Visibility
- **`C`**: Toggle Contact Points
- **`V`**: Toggle Linear Velocity
- **`W`**: Toggle Angular Velocity
- **`F`**: Toggle Linear Force
- **`T`**: Toggle Torque

---

## JSON Format Specification

If you prefer to generate data files manually or from another language, SimView uses a JSON format split into two main sections: `model` (static data) and `state` (dynamic data).

### Model (Static Data)

The `model` section defines the static components of your simulation, including bodies and terrain shared across all batches.

- **`simBatches`** *(integer)*
  The number of simulation batches to visualize. Each batch can have unique transforms for the bodies, but shares the same terrain.
  *Example*: `2` for two parallel simulations.

- **`scalarNames`** *(array[string])*
  A list of names for scalar properties (e.g., `"energy"`, `"reward"`) that can vary over time and across batches.

- **`bodies`** *(array)*
  An array of objects representing the physical bodies in the simulation. Each body includes:
  - **`name`** *(string)*
    A unique identifier for the body (e.g., `"Box"`).
  - **`shape`** *(object)*
    Defines the body’s geometry:
    - **`type`** *(integer)*
      The shape type:
      - `0`: Custom (user-defined)
      - `1`: Box (requires `hx`, `hy`, `hz`)
      - `2`: Sphere (requires `radius`)
      - `3`: Cylinder (requires `radius`, `height`)
    - **`hx`, `hy`, `hz`** *(float)*
      Half-lengths along x, y, z axes for a box shape.
    - **`radius`** *(float)*
      Radius for sphere or cylinder shapes.
    - **`height`** *(float)*
      Height for cylinder shapes.
  - **`bodyTransform`** *(array[array[7]])*
    An array of transforms, one per batch. Each transform is `[x, y, z, w, qx, qy, qz]`, where:
    - `[x, y, z]`: Position
    - `[w, qx, qy, qz]`: Quaternion rotation (scalar-first).
  - **`bodyPoints`** *(array[array[3]])*
    Points in the body’s local frame used for collision detection, each as `[x, y, z]`.

- **`terrain`** *(object)*
  Defines the terrain shared across all batches:
  - **`dimensions`** *(object)*
    - **`sizeX`, `sizeY`** *(float)*: Physical size of the terrain.
    - **`resolutionX`, `resolutionY`** *(integer)*: Number of grid points.
  - **`bounds`** *(object)*: `minX`, `maxX`, `minY`, `maxY`, `minZ`, `maxZ`.
  - **`heightData`** *(array[float])*: A flattened 2D array of height values.
  - **`normals`** *(array[array[3]])*: Surface normals for each grid point.

### State (Dynamic Data)

The `state` section captures the simulation’s current state at a specific time.

- **`time`** *(float)*
  The current simulation time in seconds.

- **`bodies`** *(array)*
  Dynamic properties for each body across all batches:
  - **`name`** *(string)*
    Matches the body name from the `model`.
  - **`bodyTransform`** *(array[array[7]])*
    Current transforms for each batch (`[x, y, z, w, qx, qy, qz]`).
  - **`bodyVelocity`** *(array[array[6]])*
    Velocities for each batch, as `[vx, vy, vz, ωx, ωy, ωz]`.
  - **`bodyForce`** *(array[array[6]])*
    Forces and torques for each batch, as `[fx, fy, fz, τx, τy, τz]`.
  - **`contacts`** *(array[array[integer]])*
    An array of contact point indices (from `bodyPoints`) for each batch.
  - **[Scalar Values]** *(array[float])*
    For each name in `model.scalarNames`, an array of values, one per batch.

---

## Examples

### Example Model (2 Batches)

This defines a simple model with one box in two simulation batches:

```json
{
  "model": {
    "simBatches": 2,
    "scalarNames": ["energy"],
    "bodies": [
      {
        "name": "Box",
        "shape": { "type": 1, "hx": 1.0, "hy": 1.0, "hz": 1.0 },
        "bodyTransform": [
          [0, 0, 0, 1, 0, 0, 0],  // Batch 1: Positioned at origin
          [2, 0, 0, 1, 0, 0, 0]   // Batch 2: Shifted 2 units along x-axis
        ],
        "bodyPoints": [[0, 0, 0]]  // Single collision point at center
      }
    ],
    "terrain": {
      "dimensions": { "sizeX": 10.0, "sizeY": 10.0, "resolutionX": 2, "resolutionY": 2 },
      "bounds": { "minX": -5.0, "maxX": 5.0, "minY": -5.0, "maxY": 5.0, "minZ": 0.0, "maxZ": 0.0 },
      "heightData": [0.0, 0.0, 0.0, 0.0],
      "normals": [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]]
    }
  }
}
```

### Example State (2 Batches)

This shows the dynamic state of the above model at time 1.5 seconds:

```json
{
  "time": 1.5,
  "bodies": [
    {
      "name": "Box",
      "bodyTransform": [
        [0, 0, 1, 1, 0, 0, 0],  // Batch 1: Moved up 1 unit
        [2, 0, 0, 1, 0, 0, 0]   // Batch 2: Still at initial position
      ],
      "bodyVelocity": [
        [0, 0, -0.1, 0, 0, 0],
        [0, 0, 0, 0, 0, 0]
      ],
      "contacts": [
        [0],  // Batch 1: Center point in contact
        []    // Batch 2: No contacts
      ],
      "energy": [1.2, 0.1]
    }
  ]
}
```

---

## Notes

- **Quaternion Convention**
  Quaternions use `[w, x, y, z]` (scalar-first format).

- **Terrain Consistency**
  Ensure `heightData` and `normals` arrays contain exactly `resolutionX * resolutionY` elements.

- **Batch Synchronization**
  All arrays (e.g., `bodyTransform`, `bodyVelocity`) must have the same length as `simBatches`.

- **Contact Points**
  The `contacts` field lists indices from `bodyPoints` for each batch. An empty array means no contacts.
