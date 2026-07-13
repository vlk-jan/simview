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

SimView caches some temporary files for visualization. It also cleans up any
`simview_viz_*.json` temp scene files left behind by older versions (a launched viewer
now serves an in-memory `SimulationScene` directly, without writing one). You can clear
all of this using the following command:

```bash
simview clear
```

### Visualization of exported simulations

To visualize a simulation defined in a JSON file, run the following command, replacing `[path_to_json_file]` with the actual path to your JSON data:

```bash
simview [path_to_json_file]
```

Gzip-compressed files (e.g. `scene.json.gz`) are detected automatically and decompressed
transparently — no separate flag needed.

Useful flags:

```bash
simview scene.json --host 0.0.0.0 --port 8080  # bind to a specific host/port
simview scene.json --no-browser                # don't auto-open a browser tab
simview --version                               # print the installed version
```

### Comparing multiple runs (e.g. real-world vs. simulated)

Pass multiple JSON files to merge them into a single scene, each file's batches appended
as extra batches in the viewer:

```bash
simview real_world.json simulated.json
```

The files must describe the same physical setup (identical bodies and terrain grid) —
that's what makes the batches comparable. They don't need to share a timeline: the
**first** file's timestamps become the merged timeline, and every other file is
resampled onto it by nearest timestamp (no interpolation), so put the recording you
care most about matching frame-for-frame first. See [Analysis Panel](#analysis-panel)
below for a way to quantify the difference between two merged batches.

Each merged file's batches are auto-named after its filename (e.g. `real_world`,
`simulated`), shown in the [Batch Legend](#batch-legend). You can rename them from
there — renames are saved next to the input file(s) and reloaded automatically the
next time you open the same file(s). You can also set initial batch names yourself by
including a `batchNames` array directly in the JSON's `model` object (see
[JSON Format Specification](#json-format-specification)); renames from the UI take
precedence over this once saved.

To merge files without launching the viewer, e.g. to inspect or re-share the merged
scene, pass `--save-merged`:

```bash
simview real_world.json simulated.json --save-merged combined.json.gz
```

The output is gzipped if the path ends in `.gz`.

---

## Visualization Controls

Once the visualizer is running, you can interact with the simulation using the following controls:

### Camera

- **Rotate**: Left-click + drag OR `Ctrl` (`CMD` on Mac) + Arrow keys
- **Pan**: Right-click + drag OR Arrow keys
- **Zoom**: Scroll wheel
- **Track Body**: Automatically follow a specific body (via the "Camera Options" menu)
- **Split Screen**: Compare two batches side-by-side (via the "Camera Options" menu, requires ≥2 batches)
- **Field of View**: Adjust camera FOV (via the "Camera Options" menu)

### Timeline

- **Step Forward/Backward**: `Alt` + Arrow Right / Arrow Left
- **Seek (and Pause)**: Click on the timeline bar
- **Play/Pause**: `Space` or Click the Play button
- **Record**: `R` or Click the Record button (Select MP4/WEBM or PNG sequence via dropdown)
- **Playback Speed**: Adjust speed (0.1x to 5x) via the dropdown next to the timeline

### Batch Selection

- **Move Selection**: `Shift` + Arrow keys

### Visualization Options

- **`B`**: Toggle Body Visualization Mode (Mesh / Wireframe / Points)
- **`A`**: Toggle Axes Visibility
- **`G`**: Toggle Trajectory Trails
- **`C`**: Toggle Contact Points
- **`V`**: Toggle Linear Velocity
- **`W`**: Toggle Angular Velocity
- **`F`**: Toggle Linear Force
- **`T`**: Toggle Torque
- **`P`**: Toggle Terrain Data Probe (interactive tooltip on hover)

You can also customize terrain colors, colormaps, and toggle surface/wireframe/normals from the "Terrain Options" menu.

### Trajectory Trails

Toggling trails (`G`, or "Show Trails" in the Body Options panel) draws each body's
path from the start of the simulation up to the current playback time, one line per
batch in that batch's color. Useful for comparing the overall shape of two
trajectories (e.g. real vs. simulated) at a glance instead of scrubbing frame by frame.

### Analysis Panel

Scalars and Error Metrics share one collapsible panel at the top-center of the screen.
When both are available, a mode switcher lets you flip between them; if only one is
available (e.g. a single-batch scene has no Error Metrics), that one is shown directly
without the switcher.

- **Scalars**: one tab per scalar defined in the model, each plotting its value over
  time for every batch (colored per batch, click a line to focus that batch).
- **Error Metrics**: shown once a scene has 2 or more batches. Pick a body and two
  batches ("Batch A" / "Batch B") to compare — e.g. the real and simulated batches
  produced by [merging multiple files](#comparing-multiple-runs-eg-real-world-vs-simulated)
  — and it computes, over the full timeline, the Euclidean position error and the
  quaternion angle (orientation) error between the two batches for that body. A live
  readout shows the current-frame values, and the chart plots both error curves over
  time with a marker at the current playback position.

### Batch Legend

When a scene has 2 or more batches, a toggleable "Batches" legend appears in the
bottom-right corner, listing each batch's color, index, and name. Click a row to focus
that batch, or click a name to rename it in place — renames persist next to the input
file(s), so they survive a reload or server restart.

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
- **`batchNames`** *(array[string], optional)* — display name for each batch, length
  must equal `simBatches`. Shown in the [Batch Legend](#batch-legend); falls back to
  `"Batch <index>"` per entry if omitted, empty, or the wrong length. Renames made from
  the Batch Legend are persisted server-side (see below) and take precedence over this
  field on subsequent loads.
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

> **Binary state fields.** The numeric per-body fields (`bodyTransform`, `velocity`,
> `angularVelocity`, `force`, `torque`) may alternatively be a string of the form
> `"__b64__<base64>"`, where the base64 payload is the little-endian float32 bytes of the
> batched array in row-major order (`bodyTransform` is width 7, the vectors width 3). This
> is what [`SimulationScene.add_trajectory`](#authoring-whole-trajectories) emits by
> default; the viewer and the file-merge decode it transparently. `contacts`, scalars, and
> `time` are always plain JSON.

### Authoring whole trajectories

Building states one frame at a time (`add_state`) is fine for short scenes, but for long,
dense trajectories prefer `SimulationScene.add_trajectory`, which appends an entire
time-series in one call — converting each body's tensors once instead of per frame, and
packing the numeric fields as the binary blobs described above (typically ~3× smaller
files and noticeably faster save/load):

```python
from simview import SimulationScene, BodyShapeType, BodyTrajectory

scene = SimulationScene(batch_size=B, scalar_names=[], dt=0.001)
scene.create_terrain(...)
scene.create_body(body_name="box", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.3, hz=0.15)

# positions: (T, B, 3), orientations: (T, B, 4) as [w, x, y, z]
# (2-D (T, 3) / (T, 4) is accepted when batch_size == 1)
scene.add_trajectory(
    times=times,                                  # length-T sequence or tensor
    trajectories=[BodyTrajectory("box", positions, orientations)],
)
scene.save("scene.json")
```

Pass `binary=False` to emit plain JSON lists instead.

For large simulations, pass `compress=True` to `save()` (or use a `.gz` filepath) to
gzip the output — `SimulationScene.load()`, the CLI, and the server all detect and
decompress it transparently regardless of extension.

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

The web interface uses [**uPlot**](https://github.com/leeoniya/uPlot) (MIT licensed) for
scalar and error-metric plotting; it is vendored under `simview/static/lib/`. Three.js and
chroma-js are loaded from the jsdelivr CDN, pinned to exact versions with Subresource
Integrity (SRI) hashes. All third-party libraries used by SimView are permissively
licensed (MIT/BSD), so there are no licensing restrictions on commercial use.
