# Visualization Controls

Once the visualizer is running, you can interact with the simulation using the following controls:

## Camera

- **Rotate**: Left-click + drag OR `Ctrl` (`CMD` on Mac) + Arrow keys
- **Pan**: Right-click + drag OR Arrow keys
- **Zoom**: Scroll wheel
- **Track Body**: Automatically follow a specific body (via the "Camera Options" menu)
- **Split Screen**: Compare two batches side-by-side (via the "Camera Options" menu, requires ≥2 batches)
- **Field of View**: Adjust camera FOV (via the "Camera Options" menu)
- **Copy View Link**: Click the "Copy view link" button (in the "Camera Options" menu) to copy a
  URL that encodes the current camera, playback time, focused batch, and visualization toggles --
  opening it restores that view.

## Timeline

- **Step Forward/Backward**: `Alt` + Arrow Right / Arrow Left
- **Seek (and Pause)**: Click on the timeline bar
- **Play/Pause**: `Space` or Click the Play button
- **Record**: `R` or Click the Record button (select WEBM, MP4 -- if your browser supports
  recording it -- or PNG sequence via the dropdown). Recording seeks to the start, plays
  exactly one loop, then automatically stops and downloads the file.
- **Screenshot**: `S` or Click the camera button next to Record to save the current frame as a PNG.
- **Playback Speed**: Adjust speed (0.1x to 5x) via the dropdown next to the timeline

## Batch Selection

- **Move Selection**: `Shift` + Arrow keys

## Visualization Options

- **`B`**: Toggle Body Visualization Mode (Mesh / Wireframe / Points)
- **`A`**: Toggle Axes Visibility
- **`G`**: Toggle Trajectory Trails
- **`I`**: Toggle Smooth Interpolation (on by default; interpolates position/orientation between recorded states during playback and scrubbing instead of snapping to the nearest frame)
- **`C`**: Toggle Contact Points
- **`V`**: Toggle Linear Velocity
- **`W`**: Toggle Angular Velocity
- **`F`**: Toggle Linear Force
- **`T`**: Toggle Torque
- **`P`**: Toggle Terrain Data Probe (interactive tooltip on hover)

You can also customize terrain colors, colormaps, and toggle surface/wireframe/normals from the "Terrain Options" menu.

## Point Cloud and Terrain Similarity Coloring

Point-cloud bodies and terrain cells can each carry an optional per-point/per-cell
feature embedding (see `create_pointcloud(embedding=)` / `create_terrain(embedding_map=)`
in the [JSON format](../dev/json-format.md)). When present, clicking a point (with
"Point Color Mode" already set to "similarity" in the Body Options panel) or a terrain
cell (with "Data Probe" off and terrain "features" color mode already selected)
recolors the whole cloud/grid by cosine similarity to the clicked location — computed
entirely client-side, no backend round-trip. A colormap legend (coolwarm, [-1, 1])
appears alongside the existing terrain legend to read values off the result. Clicking
without the matching mode active is an ordinary object selection and has no other effect.

## Trajectory Trails

Toggling trails (`G`, or "Show Trails" in the Body Options panel) draws each body's
path from the start of the simulation up to the current playback time, one line per
batch in that batch's color. Useful for comparing the overall shape of two
trajectories (e.g. real vs. simulated) at a glance instead of scrubbing frame by frame.

## Analysis Panel

Scalars and Error Metrics share one collapsible panel at the top-center of the screen.
When both are available, a mode switcher lets you flip between them; if only one is
available (e.g. a single-batch scene has no Error Metrics), that one is shown directly
without the switcher.

- **Scalars**: one tab per scalar defined in the model, each plotting its value over
  time for every batch (colored per batch, click a line to focus that batch). An
  "Export CSV" button on the active tab downloads its full series as `time` plus one
  column per batch, named after each batch's current display name.
- **Error Metrics**: shown once a scene has 2 or more batches. Pick a body and two
  batches ("Batch A" / "Batch B") to compare — e.g. the real and simulated batches
  produced by [merging multiple files](cli.md#comparing-multiple-runs-eg-real-world-vs-simulated)
  — and it computes, over the full timeline, the Euclidean position error and the
  quaternion angle (orientation) error between the two batches for that body. A live
  readout shows the current-frame values, and the chart plots both error curves over
  time with a marker at the current playback position. The "Per-axis" toggle swaps the
  combined position error curve for the signed X/Y/Z error components (Batch A minus
  Batch B), useful for spotting a directional bias instead of just overall magnitude.
  Below the readout, a compact stats block summarizes the full timeline: position
  RMSE, the max position error (and when it occurs), the final-frame drift, and the
  orientation RMSE and max angle error. An "Export CSV" button downloads the current
  selection's per-frame series (`time`, `pos_error`, `err_x`, `err_y`, `err_z`,
  `angle_error_deg`).

## Batch Legend

When a scene has 2 or more batches, a toggleable "Batches" legend appears in the
bottom-right corner, listing each batch's color, index, and name. Click a row to focus
that batch, or click a name to rename it in place — renames persist next to the input
file(s), so they survive a reload or server restart.

## Scene Info

When the scene JSON includes a `model.metadata` object, a read-only "Scene Info" panel
appears in the GUI listing each key/value pair — e.g. the engine, checkpoint path, git
commit, or CLI args a run was produced with — so a scene saved months ago is still
self-describing. `simview info <file>` prints the same fields on the command line.
