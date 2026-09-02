# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [4.2.1] - 2026-09-02

### Added

- **"Show Point Clouds" toggle** in Body Options, for scenes that contain point-cloud
  bodies. Point clouds are no longer governed by Body Visualization Mode (see below),
  so this is how they are hidden and shown.

### Fixed

- **Mesh bodies no longer disappear once a run travels away from where it started.**
  Bodies are drawn as instanced meshes positioned per instance, and THREE caches an
  instanced mesh's bounding sphere the first time it is frustum-tested and never
  invalidates it when the instances move — so every mesh body was culled wholesale as
  soon as its *starting* position left the view. Long recordings (a robot driving a few
  hundred metres) lost their bodies mid-playback while the terrain kept rendering.
- **Selecting the "points" visualization mode no longer blanks out every mesh body.**
  A point-cloud body is the object itself rather than a way of drawing a body, so it no
  longer contributes "points" to the mode list, and Body Visualization Mode — `none`
  included — leaves point clouds alone. In a mixed scene (a robot plus a lidar cloud)
  the mode offered only `points`, which no mesh body could render.
- **Static point clouds are no longer listed in the Body states panel**, where they
  showed a permanently-zero Position/Rotation. A point cloud that does carry per-frame
  data stays listed like any other body.
- **The Analysis panel's scalar chart now actually draws.** It had been painting
  nothing at all: its x scale was never pinned (uPlot treats a scale's `min`/`max` as
  outputs — `range` is the pin — so the initial autoscale over empty data nulled it and
  no later update revisited it), the render loop redrew without rebuilding paths, so the
  chart kept redrawing whatever data it first saw, and the y axis offered a single tick
  increment that could not fit the panel's height, so uPlot drew no ticks or labels. An
  end-to-end test now asserts the chart paints its data and its axis rather than merely
  that the panel opens.
- **The camera's far plane and orbit limit now follow the terrain extent** instead of
  being fixed at 500 m, so terrain and bodies on scenes hundreds of metres across no
  longer clip away, and the whole scene can be framed.

## [4.2.0] - 2026-08-31

### Added

- **Merging a subset of a file's batches.** Append `#<batches>` to any input file to
  contribute only some of its batches to the merged scene, e.g.
  `simview gt.json method_a.json#1 method_b.json#1` — so several files that each
  carry their own copy of a shared ground truth can be compared without merging that
  ground truth once per file. The selector takes indices (`#1`), comma-separated lists
  (`#0,2`), inclusive ranges (`#1-3`), negative indices (`#-1`) and the file's own
  `batchNames` (`#ours`); merged batch names keep the source file's index (`run[2]`).
  Works with `--save-merged`, with remote inputs, and on a single file (to view only
  some of its batches). `merge_simulation_files(paths, selections=...)` is the Python
  equivalent. See [CLI](https://vlk-jan.github.io/simview/usage/cli/).
- `create_terrain(property_bounds=...)` pins the color-scale range of a named terrain
  property explicitly, e.g. `property_bounds={"friction": (0.0, 1.0)}`, instead of
  always deriving it from that map's own min/max — so the same scale (and legend)
  stays comparable across scenes. Properties left out keep the data-range default,
  and cells outside an explicit range saturate at the end colors.
- Each Error Metrics readout is prefixed with a swatch in its plot series color, so the
  readout doubles as a legend for the curves below it.

### Fixed

- Nested fields in the Scene Info panel now start collapsed. A scene with rich metadata
  used to expand every nested key at once, burying the top-level entries.

## [4.1.0] - 2026-08-19

### Added

- **Remote scene files.** Anywhere the CLI takes an input file (view, `info`, `diff`,
  `terrain`, `render`, and multi-file merges) it now also accepts an scp-style
  `host:path`, fetched over the system `ssh` and cached locally. Transfers are
  compressed (gzipped on the remote, or `ssh -C` when it has no `gzip`), and the cache
  entry carries the remote file's mtime, so freshness is a plain `stat` comparison.
  Adds `--refresh`/`--offline`, and `simview clear` knows about the new cache. See
  [CLI](https://vlk-jan.github.io/simview/usage/cli/).
- The columnar ("v4") states layout is now an **on-disk** format, not just a
  server-side repack: `SimulationScene.save()` writes it by default, producing
  substantially smaller files that the viewer can load without any repacking.
  Pass `columnar=False` for the previous per-frame layout, or `columnar=True` to
  raise instead of falling back when a scene is too irregular to pack. See the
  [JSON Format Specification](https://vlk-jan.github.io/simview/dev/json-format/).
- `simview info` reports which `states` layout a file uses.
- **Episodes.** An episodic (e.g. RL) recording can mark its resets with
  `SimulationScene.mark_episode()` / `LiveViewer.mark_episode()`, serialized as an
  optional `model.episodes` array. The viewer ticks episode boundaries on the playback
  bar, adds |◀ / ▶| navigation (`[` / `]`), and overlays per-episode aggregates
  (including the episode return) on the scalar plots. See
  [Episodes](https://vlk-jan.github.io/simview/usage/episodes/).
- **Focused-batch rendering.** Above 32 batches the viewer now draws only the focused
  batch by default, and builds each batch's per-batch scene objects (axes, arrows,
  point clouds, contact points) the first time it's rendered rather than all up front —
  so a scene with hundreds of parallel envs loads and runs like a single-env one.
  Toggle with "Render All Batches" in Body Options.
- **Windowed state loading.** The `/blob` endpoint now supports HTTP Range requests, and
  the viewer uses them to stream the large current-frame-only fields (`velocity`,
  `angularVelocity`, `force`, `torque`) in ~1 MB windows around the playhead instead of
  materializing whole `(T, B, k)` runs. `bodyTransform` and the scalars stay fully
  resident, since trails, error metrics, the terrain profile and the scalar plots all
  walk the entire trajectory.

### Changed

- `SimulationScene.save()` writes columnar `states` by default. Files stay readable
  by `load`, `merge_simulation_files`, `simview info`/`diff`/`terrain` and the viewer
  either way, but a third-party tool that parses `states` as a JSON array will need
  to handle the object form (or be passed `columnar=False`).
- A fully shared (singleton) terrain now ships exactly one copy of its height, normals,
  properties and embedding data instead of one identical copy per batch — a real saving
  for many-batch (e.g. RL-scale) scenes. Readers resolve the layout from the data
  length, so files written by older versions (which broadcast the singleton) keep
  working; a mixed terrain still broadcasts its shared fields.

### Fixed

- `LiveViewer.push_state` no longer blocks the simulation loop on a slow or hung viewer
  tab (up to 5 s per frame before). Frames go through a bounded queue drained by a
  sender thread, dropping the oldest pending frame when it fills so the live view keeps
  tracking the simulation; dropped frames still land in `scene.states` and the catch-up
  buffer, and `stop()` flushes the backlog.
- The live frame buffer is now bounded (`frame_buffer_size`, 10k frames by default)
  instead of growing for the length of a run, and a viewer connecting mid-run replays
  the recent window in 500-frame slices rather than one `json.dumps` of the whole
  history. It is registered for live broadcasts only once the replay has caught up, so
  a new frame can no longer overtake the history it follows.
- Trails are now appended to in place instead of being rebuilt per loaded chunk, which
  in live mode cost O(T²) geometry reallocation over a run.
- `simview diff` resolves parent chains and compares world poses, like the viewer's
  Error Metrics panel does — the two used to report different numbers for the same
  scene. Rigidly-attached bodies (a constant `localTransform`, absent from `states`)
  are now diffable and addressable via `--body`.
- Mesh bodies authored from tensors crashed the viewer on load: `createGeometry` called
  `.flat()` on vertices that always arrive blob-decoded as flat `Float32Array`s. Meshes
  are also indexed with `Uint32Array` now, so more than 65535 vertices no longer wrap.
- Serving an in-memory scene (`show()`, `LiveViewer`, `SimViewLauncher`) no longer
  rewrites the caller's model in place, which left a later `save()` writing dead
  `/blob/...` URLs and a second `show()` serving stale blob references.
- `merge_simulation_files` carries terrain `embeddingData` (the features color mode was
  silently lost on merged scenes) and each model's `metadata` (namespaced under
  `metadata.sources`) through the merge, groups b64-decoded terrain normals back into
  per-vertex vec3s, and rejects inputs whose terrain x/y bounds differ instead of
  merging them into spatially misaligned batches.
- `add_state` normalizes a 0-dim scalar tensor/array to the per-batch list every other
  frame stores, which `merge_simulation_files` used to raise on.
- `SimulationScene`'s internal-data cleanup frees the terrain's per-cell `embedding_data`
  too, potentially the largest of its arrays.
- A blob fetch that returns an HTTP error now fails loudly on the load-error splash
  instead of being decoded as float32 garbage, and inline `__b64__` state fields decode
  endian-safely like the standalone blob path already did.
- `setActiveBatch` no longer forwards an out-of-range batch index to the body state
  window, scalar plotter and batch legend right after warning that it rejected it.
- Dropped `allow_credentials` from the CORS config: combined with the any-localhost-port
  origin regex it let any other local dev server read scene data with the user's
  credentials. The API uses no cookies or auth headers, so nothing needed it.

### Removed

- The ctrl+drag box-selection code path, which never worked — it crashed on mouseup,
  raycast against an always-empty list, and checked event keys that don't exist. Click
  handling, the data probe tooltip and shift+arrow batch switching are unaffected.

## [4.0.0] - 2026-08-04

### ⚠ Breaking changes

- **Scene JSON files saved by older versions of simview will not load.** Terrain's
  `frictionData`/`stiffnessData` fields and their `bounds.minFriction`/`maxFriction`/
  `minStiffness`/`maxStiffness` entries are replaced by a generic
  `terrain.properties` object (`{name: {data, min, max}}` — see the
  [JSON Format Specification](https://vlk-jan.github.io/simview/dev/json-format/)).
  Re-save any existing scene file with the current version of `simview` (or
  `SimulationScene.load()` + `save()`) to pick up the new format; there is no
  automatic migration.
- `scene.create_terrain()`/`SimViewModel.create_terrain()` no longer accept
  `friction_map=`/`stiffness_map=`; pass `properties={"friction": ..., "stiffness": ...}`
  instead (or any other named per-cell scalar map — see below).
- The batch-names sidecar file (`.<scene>.<hash>.batchnames.json`) written before
  staleness-fingerprinting was added (pre-3.x) is no longer read; a fresh
  `POST /batch-names` regenerates it in the current format.
- The model JSON's long-superseded `batchSize` field (renamed to `simBatches` several
  releases ago) is no longer read as a fallback.

### Added

- Terrain scalar properties (friction, stiffness, or any other per-cell field) are
  now a fully generic, arbitrarily-named mechanism end to end — Python
  (`SimViewTerrain.properties`), the CLI (`simview terrain --layer <name>`,
  `simview info`, `simview merge`), and the viewer (color mode dropdown, Legend,
  hover/probe tooltip, Terrain Profile tab) all support any property name supplied
  at authoring time, with zero code changes required to add a new one.
- `scene.create_pointcloud()` now accepts optional `color` (static per-point RGB) and
  `embedding` (per-point feature vector) tensors; `scene.create_terrain()` gains a
  matching `embedding_map` (per-cell feature vector). When present, clicking a point
  or terrain cell recolors the whole body/grid by cosine similarity to the clicked
  location, computed client-side — a new "similarity" Point Color Mode for point
  clouds and "features" terrain color mode, both with a matching colormap legend.

### Fixed

- Clicking now only recolors a point cloud/terrain by similarity when the matching
  mode is already selected from its dropdown; otherwise it's an ordinary selection,
  and a click does nothing at all unless "Data Probe" or similarity mode is active.
- The Analysis panel's "Terrain" tab no longer appears for bodies with no trajectory
  (e.g. a static point cloud), and now plots the whole trajectory up front instead of
  only revealing it progressively during playback.
- "Scene Info" now shows full metadata keys/values instead of truncating them.

## [3.6] - 2026-07-29

### Added

- `SimulationScene`/`SimViewModel` now accept an optional free-form `metadata`
  dict (e.g. engine name, checkpoint path, git commit, CLI args) carried
  through to the saved JSON, `simview info`, and a read-only "Scene Info"
  panel in the browser, so a scene stays self-describing long after it was
  generated.
- `scene.create_terrain()` now auto-computes normals from the heightmap gradients if `normals` is omitted.
- `scene.create_terrain()` now accepts `grid_res` to auto-infer spatial `x_lim`/`y_lim` constraints instead of requiring manual definition.
- `simview terrain <file> --along-body BODY`: sample terrain layer(s)
  bilinear-interpolated at a body's per-frame (x, y) position — "what
  terrain is under the robot's driven path". With `--batches A B`, both
  batches' terrains are sampled along batch A's (reference, typically
  ground-truth) trajectory and reported as `value_a`/`value_b`/`delta`
  per layer, so the delta reflects property differences under the path
  rather than trajectory divergence. Honors `--layer`/`--every` and the
  usual `--json`/`--csv` output modes.
- "Terrain" tab in the browser Analysis panel: plots a terrain layer
  (height/friction/stiffness) sampled under a body's path over time, one
  series per batch, with layer/body pickers, a path picker ("own path"
  per batch, or every batch's terrain along one reference batch's path —
  e.g. ground truth's), playback-synced reveal, click-to-seek, and CSV
  export. The browser-side counterpart of `simview terrain --along-body`.
- `--fail-on-exceed` flag for `simview diff`: exits with code 2 (after
  printing the normal report) when any diffed body's trajectory exceeds
  `--pos-threshold`/`--rot-threshold-deg`, and 0 when within them --
  distinct from the usage/parse-error exit 1, so scripts and CI can use an
  exported scene as a regression tripwire.

### Fixed

- Focusing a batch while a Scalars plot was open threw
  `s.stroke is not a function` on the next redraw (uPlot expects
  `series.stroke` to stay a function; the focus handler was overwriting it
  with a color string).

## [3.5] - 2026-07-28

### Added

- `simview render <file> --output frame.png`: headless PNG screenshot via a
  real (headless) browser driving a real `SimViewServer` instance, with
  `--view`/`--width`/`--height` options. Ships as a new optional `render`
  extra rather than a hard dependency.
- Terrain diff color overlay: a "diff" color mode (diverging colormap
  centered on zero) plus Diff Layer/Batch A/Batch B pickers in Terrain
  Options, with a matching diverging colorbar in the Legend.
- The terrain data probe now shows every batch's height/friction/stiffness
  at the hovered cell, plus each one's delta from a reference batch, instead
  of just the hovered batch.
- `--per-axis` flag for `simview diff`, reporting signed `err_x`/`err_y`/
  `err_z` (batch A minus batch B) per frame in `--json`/`--csv` output.
- Mean/min `|delta|` stats (alongside the existing max) in
  `simview terrain --batches --area` output.
- Full documentation site (MkDocs + mkdocs-material + mkdocstrings) covering
  usage, the CLI, the JSON format specification, the API reference, and a
  developer guide, published to GitHub Pages. `README.md` is trimmed to a
  landing page that links to it.

### Changed

- The Error Metrics panel auto-selects a sensible Batch A/B default from
  batch names (e.g. ground-truth vs. post-adaptation) instead of always
  defaulting to indices 0/1, falling back to 0/1 when no batch name matches.

## [3.4] - 2026-07-27

### Added

- `simview info <file>`: a structural summary of a scene JSON (model/terrain/
  body/state breakdown, columnar-repack eligibility, consistency warnings) in
  human-readable text or `--json`.
- `simview terrain <file> --point/--area`: numeric height/friction/stiffness
  queries (bilinear-interpolated at a point, or a raw grid over an area), plus
  `--batches A B` to compare two batches (`value_a`/`value_b`/`delta` per
  layer).
- `simview diff <file> --batches A B`: per-frame position/orientation
  divergence between two batches' trajectories, with `--body`/`--every`/
  `--pos-threshold`/`--rot-threshold-deg` options.
- `--csv` output for `simview diff` and `simview terrain`, alongside the
  existing `--json`.

### Changed

- Only emit uvicorn's access log when running in debug mode.

## [3.3] - 2026-07-17

### Added

- Expose the installed package version as `simview.__version__`.
- Test against Python 3.14 in CI and advertise it in the package classifiers.
- Dependabot configuration for GitHub Actions, npm, and Python dependencies.

### Changed

- Bump the PyPI development-status classifier to `5 - Production/Stable`.
- Use uvicorn's modern sansio websocket implementation for the live server when
  available, silencing the `websockets.legacy` deprecation warning.
- Raise the CI coverage floor from 80% to 83%.

### Removed

- Unused `collapsedMode`/`focusedMode` placeholder flags from `BatchManager`.

## [3.2] - 2026-07-15

### Added

- Shareable view links: the current camera/playback state is encoded in the URL
  hash so a view can be restored or handed off.
- Single-frame PNG screenshot export.

### Changed

- Prepare packaging for PyPI publishing (metadata, build, publish workflow).
- Replace CCapture with the browser-native `MediaRecorder` for video recording,
  covered by an e2e test.

### Fixed

- Unblock CI: guard the optional `numpy` import and add `--no-launch` to
  `example.py`.
- Plot visualization fixes.

## [3.1] - 2026-07-14

### Added

- Live streaming mode: `LiveViewer` pushes states to connected browser tabs over
  WebSocket as a simulation runs.
- Non-blocking `scene.show()` with Jupyter iframe support (`_repr_html_`).
- Smooth interpolated playback (position lerp + quaternion slerp) with a toggle.
- Error-metric summary stats and CSV export in the analysis panel.

### Changed

- Vendor three.js and chroma-js locally so the viewer works fully offline.
- Serve states as per-body whole-trajectory binary columns ("v4" columnar
  repack), backed by a `Float32Array` `StateStore`, for much cheaper playback of
  long recordings.

### Fixed

- Binary-search seek for non-uniform timelines, parallel blob fetches, and
  versioned immutable blob URLs.

### Testing / infrastructure

- Add vitest + Playwright frontend tests, pyright type checking, and a CI
  coverage floor.

## [3.0] - 2026-07-13

Baseline release. Highlights of the surface established by this version:

- **Authoring API** — `SimulationScene` with incremental model building,
  `add_state`/`add_trajectory` (batched, binary-encoded), gzip support, and
  JSON save/load.
- **Wire format** — HTTP-served `model`/`states`, binary-encoded numeric fields,
  parent-relative (rigid and articulated) body transforms, grouped body names.
- **Frontend** — vanilla-JS/THREE.js viewer with batched split-screen
  comparison, camera tracking, trajectory trails, terrain data probe, a unified
  Analysis panel (Scalars + Error Metrics, plotted with uPlot), and synchronized
  timeline scrubbing.
- **Tooling** — CLI (`simview` view / `clear` / `--save-merged`), multi-file
  merge pipeline, CORS-hardened server with cache headers, `py.typed`, and CI
  across Python 3.12/3.13 with a base-install-only check.

[Unreleased]: https://github.com/vlk-jan/simview/compare/v4.2.1...HEAD
[4.2.1]: https://github.com/vlk-jan/simview/compare/v4.2.0...v4.2.1
[4.2.0]: https://github.com/vlk-jan/simview/compare/v4.1.0...v4.2.0
[4.1.0]: https://github.com/vlk-jan/simview/compare/v4.0.0...v4.1.0
[4.0.0]: https://github.com/vlk-jan/simview/compare/v3.6...v4.0.0
[3.6]: https://github.com/vlk-jan/simview/compare/v3.5...v3.6
[3.5]: https://github.com/vlk-jan/simview/compare/v3.4...v3.5
[3.4]: https://github.com/vlk-jan/simview/compare/v3.3...v3.4
[3.3]: https://github.com/vlk-jan/simview/compare/v3.2...v3.3
[3.2]: https://github.com/vlk-jan/simview/compare/v3.1...v3.2
[3.1]: https://github.com/vlk-jan/simview/compare/v3.0...v3.1
[3.0]: https://github.com/vlk-jan/simview/releases/tag/v3.0
