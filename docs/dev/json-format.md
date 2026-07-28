# JSON Format Specification

If you prefer to generate data files manually or from another language, SimView uses a
single JSON document with two top-level keys: `model` (static data, sent once) and
`states` (an array of time-ordered snapshots). This is exactly what `SimulationScene.save()`
produces.

```json
{ "model": { ... }, "states": [ { ... }, { ... } ] }
```

## Model (Static Data)

- **`simBatches`** *(integer)* — number of parallel simulation instances (batches).
- **`batchNames`** *(array[string], optional)* — display name for each batch, length
  must equal `simBatches`. Shown in the [Batch Legend](../usage/controls.md#batch-legend); falls back to
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
  - **`parent`** *(string, optional)* — name of another `model.bodies[]` entry this
    body is attached to. When set, this body's pose is no longer absolute world
    space; see `localTransform` below and the `bodyTransform` note under
    [States](#states-dynamic-data).
  - **`localTransform`** *(array[7], optional)* — `[x, y, z, w, qx, qy, qz]` constant
    offset from `parent`, for bodies **rigidly** attached (e.g. a wheel bolted to a
    chassis). Set only together with `parent`. A body with `localTransform` never
    appears in any state's `bodies[]` — its world pose is derived every frame from
    its parent's current pose plus this fixed offset, saving the cost of repeating
    an unchanging transform every frame. For an **articulated** attachment (e.g. an
    arm joint) instead, set only `parent` and keep providing a per-frame
    `bodyTransform` in `states[].bodies[]` as usual — it's then interpreted as local
    to the parent's current-frame pose rather than world space.
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

## States (Dynamic Data)

`states` is an array; each element is one snapshot:

- **`time`** *(float)* — snapshot time in seconds.
- **`bodies`** *(array)* — per body:
  - **`name`** *(string | array[string])* — matches a `model.bodies[].name`. May instead be
    a list of names when several bodies move rigidly together (e.g. links welded to the same
    parent): the single entry's `bodyTransform` and other fields below then apply identically
    to every named body, instead of repeating identical data once per body. All named bodies
    must exist in `model.bodies`.
  - **`bodyTransform`** — pose. Batched: `array[array[7]]`, one `[x, y, z, w, qx, qy, qz]`
    per batch; single: a flat `[x, y, z, w, qx, qy, qz]`. Absolute world-space, unless
    the referenced body has a `parent` in `model.bodies` (see above), in which case
    this is local to that parent's current-frame pose instead. A body with a constant
    `localTransform` on the model never has a `bodyTransform` entry here at all.
  - **`contacts`** *(array[array[int]], optional)* — per batch, indices of contacting
    points (into the body's pointcloud `points`). Empty array means no contacts.
  - **`velocity`**, **`angularVelocity`**, **`force`**, **`torque`**
    *(array[array[3]], optional)* — per-batch 3-vectors.
- **`<scalarName>`** *(array[float])* — for each name in `model.scalarNames`, one value per batch.

!!! note "Binary state fields"
    The numeric per-body fields (`bodyTransform`, `velocity`,
    `angularVelocity`, `force`, `torque`) may alternatively be a string of the form
    `"__b64__<base64>"`, where the base64 payload is the little-endian float32 bytes of the
    batched array in row-major order (`bodyTransform` is width 7, the vectors width 3). Both
    `SimViewBodyState` (used by `add_state`) and
    [`SimulationScene.add_trajectory`](#authoring-whole-trajectories) emit this by default
    (typically ~3-4× smaller than the equivalent plain JSON floats); pass `binary=False` to
    either to emit plain JSON lists instead. The viewer and the file-merge decode binary
    fields transparently. `contacts`, scalars, and `time` are always plain JSON.

!!! note "Server-side columnar repack"
    This on-disk, per-frame layout never changes (and
    `simview merge` still reads/writes it as described above); but when serving a scene to
    the viewer, the server repacks `states` at load time into whole-trajectory columns --
    one binary blob per body per numeric field (and one per scalar), covering all `T`
    frames at once -- and serves a small JSON index (`{"version": 4, "times", "bodies",
    "scalars"}`) whose entries are `/blob/...` URLs, fetched in parallel and decoded into
    `Float32Array`s. This avoids materializing thousands of tiny per-frame JS objects
    just to play back a long trajectory. The repack requires the body set, per-body field
    set, and field widths to be identical across every frame (`contacts` is exempt and may
    come and go per frame); if a scene doesn't meet that, the server falls back to serving
    the legacy per-frame JSON array unchanged, which the viewer also still supports.

## Authoring whole trajectories

Building states one frame at a time (`add_state`) is fine for short scenes, but for long,
dense trajectories prefer `SimulationScene.add_trajectory`, which appends an entire
time-series in one call, converting each body's tensors once instead of per frame —
noticeably faster save/load than the same data built frame-by-frame. Both paths pack the
numeric fields as the binary blobs described above by default, so file size is comparable
either way:

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

Both `BodyTrajectory.name` and `SimViewBodyState`'s `body_name` accept a list of body names
instead of a single string, for bodies that move rigidly together (e.g. `BodyTrajectory(["link_a", "link_b"], positions, orientations)`) — the same transform (and any optional
attributes) is applied to every named body, so it only needs to be written once per frame
instead of once per body.

For large simulations, pass `compress=True` to `save()` (or use a `.gz` filepath) to
gzip the output — `SimulationScene.load()`, the CLI, and the server all detect and
decompress it transparently regardless of extension.

## Parent-relative bodies (rigid and articulated attachments)

`create_body` accepts `parent`/`local_transform` to attach a body to another body
already in the model, instead of it moving in world space:

```python
scene.create_body(body_name="chassis", shape_type=BodyShapeType.BOX, hx=0.6, hy=0.4, hz=0.2)

# Rigid attachment (e.g. a wheel bolted to the chassis): a constant offset, defined
# once, never repeated per frame. Never call add_state/add_trajectory for "left_wheel".
scene.create_body(
    body_name="left_wheel", shape_type=BodyShapeType.CYLINDER, radius=0.15, height=0.1,
    parent="chassis", local_transform=[0.4, 0.52, 0.0, 1.0, 0.0, 0.0, 0.0],
)

# Articulated attachment (e.g. an arm joint): only `parent` is set, so this body's
# pose is still supplied every frame via add_state/add_trajectory as usual -- it's
# just interpreted as local to the chassis's current-frame pose instead of world.
scene.create_body(body_name="arm_joint", shape_type=BodyShapeType.BOX, hx=0.05, hy=0.05, hz=0.2, parent="chassis")
```

A body's `parent` must already exist in the model (added before its children), which
also rules out cycles. Merging files containing rigid (constant-offset) bodies works
the same way — `merge_simulation_files` carries the `parent`/`localTransform` through
in `model.bodies` and doesn't require or emit per-frame data for them.

## Example (2 batches, one box, flat terrain)

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
