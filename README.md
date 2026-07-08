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

## Quick Start

The easiest way to get started is to run the provided example script:

```bash
python example.py
```

This script demonstrates how to use the Python API to create a simulation with wavy terrain, dynamic bodies, and time-series data.

The Python authoring API (`simview.scene`, `simview.state`, `simview.model`) depends on
`torch` and `einops`. Install them with the optional `authoring` extra shown below.
Only these are needed to *build* simulations; *viewing* an existing JSON file does not
require `torch`.

---

## Installation

Requires **Python 3.12+**.

To only view existing simulation JSON files:

```bash
pip install -e .
```

To also author simulations from Python (installs `torch` and `einops`):

```bash
pip install -e ".[authoring]"
```

For independent use of this repository, use `venv` or `uv`:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[authoring]"
```

```bash
uv sync --extra authoring
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

If you prefer to generate data files manually or from another language, SimView uses a
single JSON document with two top-level keys: `model` (static data, sent once) and
`states` (an array of time-ordered snapshots). This is exactly what `SimulationScene.save()`
produces.

```json
{ "model": { ... }, "states": [ { ... }, { ... } ] }
```

### Model (Static Data)

- **`simBatches`** *(integer)* — number of parallel simulation instances (batches).
- **`scalarNames`** *(array[string])* — names of per-batch scalar time-series (e.g. `"energy"`).
- **`dt`** *(float)* — simulation timestep in seconds. Used for playback timing; if omitted or invalid the viewer infers it from consecutive state times.
- **`collapse`** *(boolean)* — UI hint to start with the body-state window collapsed.
- **`bodies`** *(array)* — dynamic bodies. Each entry:
  - **`name`** *(string)* — unique identifier, referenced from each state.
  - **`shape`** *(object)* — geometry, keyed by a **string** `type`:
    - `"box"` — requires `hx`, `hy`, `hz` (half-extents).
    - `"sphere"` — requires `radius`.
    - `"cylinder"` — requires `radius`, `height`.
    - `"pointcloud"` — requires `points` *(array[array[3]])* in the body's local frame.
    - `"mesh"` — requires `vertices` *(array[array[3]])* and `faces` *(array[array[3]])*.
  - **`availableAttributes`** *(array[string], optional)* — which optional per-state
    fields this body provides. Any of `"contacts"`, `"velocity"`, `"angularVelocity"`,
    `"force"`, `"torque"`.
- **`staticObjects`** *(array, optional)* — non-moving geometry. Each entry has `name`,
  `isSingleton` *(boolean)*, and either `shape` (when singleton) or `shapes`
  *(array, one per batch)* using the same shape objects as bodies.
- **`terrain`** *(object)* — heightfield shared or per-batch:
  - **`dimensions`**: `sizeX`, `sizeY` *(float)* and `resolutionX`, `resolutionY` *(int)*.
  - **`bounds`**: `minX`, `maxX`, `minY`, `maxY`, `minZ`, `maxZ`. When friction/stiffness
    data is present, also `minFriction`/`maxFriction` and/or `minStiffness`/`maxStiffness`,
    which the viewer uses to normalize the color map.
  - **`isSingleton`** *(boolean)* — `true` when one terrain is shared by all batches;
    `false` when each batch has its own.
  - **`heightData`** *(array[array[float]])* — one flattened `resolutionX * resolutionY`
    grid per batch (a single flat array is also accepted and treated as one batch).
  - **`normals`** *(array[array[array[3]]])* — per-batch surface normals, one `[x, y, z]`
    per grid point.
  - **`frictionData`**, **`stiffnessData`** *(array[array[float]] | null, optional)* —
    per-batch scalar fields over the grid, selectable as terrain color modes.

### States (Dynamic Data)

`states` is an array; each element is one snapshot:

- **`time`** *(float)* — snapshot time in seconds.
- **`bodies`** *(array)* — per body:
  - **`name`** *(string)* — matches a `model.bodies[].name`.
  - **`bodyTransform`** — pose. Batched: `array[array[7]]`, one `[x, y, z, w, qx, qy, qz]`
    per batch; single: a flat `[x, y, z, w, qx, qy, qz]`.
  - **`contacts`** *(array[array[int]], optional)* — per batch, indices of contacting
    points (into the body's pointcloud `points`). Empty array means no contacts.
  - **`velocity`**, **`angularVelocity`**, **`force`**, **`torque`**
    *(array[array[3]], optional)* — per-batch 3-vectors.
- **`<scalarName>`** *(array[float])* — for each name in `model.scalarNames`, one value per batch.

### Example (2 batches, one box, flat terrain)

```json
{
  "model": {
    "simBatches": 2,
    "scalarNames": ["energy"],
    "dt": 0.1,
    "collapse": false,
    "bodies": [
      {
        "name": "Box",
        "shape": { "type": "box", "hx": 0.5, "hy": 0.5, "hz": 0.5 },
        "availableAttributes": ["velocity"]
      }
    ],
    "staticObjects": [],
    "terrain": {
      "dimensions": { "sizeX": 10.0, "sizeY": 10.0, "resolutionX": 2, "resolutionY": 2 },
      "bounds": { "minX": -5.0, "maxX": 5.0, "minY": -5.0, "maxY": 5.0, "minZ": 0.0, "maxZ": 0.0 },
      "isSingleton": true,
      "heightData": [[0.0, 0.0, 0.0, 0.0]],
      "normals": [[[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]]]
    }
  },
  "states": [
    {
      "time": 0.0,
      "bodies": [
        {
          "name": "Box",
          "bodyTransform": [
            [0, 0, 1, 1, 0, 0, 0],
            [2, 0, 1, 1, 0, 0, 0]
          ],
          "velocity": [
            [0, 0, -0.1],
            [0, 0, 0]
          ]
        }
      ],
      "energy": [1.2, 0.1]
    }
  ]
}
```

---

## Notes

- **Quaternion Convention**
  Quaternions use `[w, x, y, z]` (scalar-first format), packed into `bodyTransform` after the position.

- **Terrain Consistency**
  Each per-batch `heightData` grid and `normals` list must contain exactly
  `resolutionX * resolutionY` elements.

- **Batch Synchronization**
  Per-batch arrays (`bodyTransform`, `velocity`, scalar values, …) must have length `simBatches`.
  When `terrain.isSingleton` is `true`, `heightData`/`normals` hold a single batch that is
  reused for all instances.

- **Contact Points**
  The `contacts` field lists point indices into a body's pointcloud `points` for each batch.
  An empty array means no contacts.

---

## License and Third-Party Notices

SimView is distributed under the [BSD 3-Clause License](LICENSE).

The web interface loads several third-party libraries from CDNs, including
[**CanvasJS**](https://canvasjs.com/) for scalar plotting. **CanvasJS is a commercial
product**; its free version is licensed for non-commercial use only. If you intend to use
SimView in a commercial setting, review the CanvasJS license and obtain a license or
replace it with a permissively licensed charting library.
