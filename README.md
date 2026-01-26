# SimView Visualizer

**SimView** is a powerful and interactive tool for visualizing 3D models and terrain data in simulations. It enables you to explore and analyze multiple simulation scenarios (batches) within a shared environment, all defined through an intuitive JSON format. Whether you're simulating physical objects or comparing different runs, SimView provides a flexible and efficient way to bring your data to life.

---

## What Does SimView Do?

SimView takes a JSON file that describes:

- **Static Models**: The 3D bodies and terrain that form the foundation of your simulation.
- **Dynamic States**: Time-varying properties like position, velocity, and forces for each simulation batch.

With support for batched simulations, you can visualize multiple instances of the same bodies—each with unique transforms—side by side in the same terrain, making it ideal for comparative analysis.

---

## JSON Format Specification

The JSON input is split into two main sections: **model** (static data) and **state** (dynamic data). Below, we break down each section and its fields.

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
    *Example for 2 batches*: `[[0, 0, 0, 1, 0, 0, 0], [2, 0, 0, 1, 0, 0, 0]]`
  - **`bodyPoints` *(array[array[3]])*
    Points in the body’s local frame used for collision detection, each as `[x, y, z]`.
    *Example*: `[[0, 0, 0]]` for a single point at the center.

- **`terrain`** *(object)*
  Defines the terrain shared across all batches:
  - **`dimensions`** *(object)*
    - **`sizeX`, `sizeY`** *(float)*
      Physical size of the terrain in the x and y directions.
    - **`resolutionX`, `resolutionY`** *(integer)*
      Number of grid points along x and y axes.
  - **`bounds`** *(object)*
    - **`minX`, `maxX`, `minY`, `maxY`, `minZ`, `maxZ`** *(float)*
      The terrain’s spatial boundaries.
  - **`heightData`** *(array[float])*
    A flattened 2D array of height values in row-major order. Must have `resolutionX * resolutionY` elements.
    *Example*: `[0.0, 0.1, ...]`
  - **`normals`** *(array[array[3]])*
    Surface normals for each grid point, each as `[nx, ny, nz]`. Must match `heightData` length.

### State (Dynamic Data)

The `state` section captures the simulation’s current state at a specific time.

- **`time`** *(float)*
  The current simulation time in seconds.
  *Example*: `1.5`

- **`bodies`** *(array)*
  Dynamic properties for each body across all batches:
  - **`name`** *(string)*
    Matches the body name from the `model`.
  - **`bodyTransform`** *(array[array[7]])*
    Current transforms for each batch, same format as in `model`.
  - **`bodyVelocity`** *(array[array[6]])*
    Velocities for each batch, as `[vx, vy, vz, ωx, ωy, ωz]` (linear and angular velocity).
  - **`bodyForce`** *(array[array[6]])*
    Forces and torques for each batch, as `[fx, fy, fz, τx, τy, τz]`.
  - **`contacts`** *(array[array[integer]])*
    An array of contact point indices (from `bodyPoints`) for each batch. Empty if no contacts.
    *Example*: `[[0, 3], []]` (batch 1 has contacts at points 0 and 3; batch 2 has none).
  - **[Scalar Values]** *(array[float])*
    For each name in `model.scalarNames`, an array of values, one per batch.
    *Example*: `"energy": [1.2, 0.1]` for two batches.

---

## Key Features

- **Batched Simulations**
  Run and visualize multiple simulation instances side by side, each with independent body transforms.

- **Shared Terrain**
  Optimize memory and performance by reusing the same terrain across all batches.

- **Flexible Shapes**
  Define bodies as boxes, spheres, cylinders, or custom shapes to suit your needs.

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
      "dimensions": { "sizeX": 10.0, "sizeY": 10.0, "resolutionX": 10, "resolutionY": 10 },
      "bounds": { "minX": -5.0, "maxX": 5.0, "minY": -5.0, "maxY": 5.0, "minZ": 0.0, "maxZ": 2.0 },
      "heightData": [0.0, 0.1 /* ... 98 more values for 10x10 grid */],
      "normals": [[0, 0, 1] /* ... 99 more normals for 10x10 grid */]
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
        [0, 0, -0.1, 0, 0, 0],  // Batch 1: Falling slowly
        [0, 0, 0, 0, 0, 0]      // Batch 2: Stationary
      ],
      "bodyForce": [
        [0, 0, -1.0, 0, 0, 0],  // Batch 1: Gravity acting in z-direction
        [0, 0, 0.0, 0, 0, 0]   // Batch 2: No forces
      ],
      "contacts": [
        [0],  // Batch 1: Center point in contact
        []    // Batch 2: No contacts
      ],
      "energy": [1.2, 0.1]  // Energy values for each batch
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
