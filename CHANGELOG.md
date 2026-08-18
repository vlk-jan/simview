# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The columnar ("v4") states layout is now an **on-disk** format, not just a
  server-side repack: `SimulationScene.save()` writes it by default, producing
  substantially smaller files that the viewer can load without any repacking.
  Pass `columnar=False` for the previous per-frame layout, or `columnar=True` to
  raise instead of falling back when a scene is too irregular to pack. See the
  [JSON Format Specification](https://vlk-jan.github.io/simview/dev/json-format/).
- `simview info` reports which `states` layout a file uses.

### Changed

- `SimulationScene.save()` writes columnar `states` by default. Files stay readable
  by `load`, `merge_simulation_files`, `simview info`/`diff`/`terrain` and the viewer
  either way, but a third-party tool that parses `states` as a JSON array will need
  to handle the object form (or be passed `columnar=False`).

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

[Unreleased]: https://github.com/vlk-jan/simview/compare/v4.0.0...HEAD
[4.0.0]: https://github.com/vlk-jan/simview/compare/v3.6...v4.0.0
[3.6]: https://github.com/vlk-jan/simview/compare/v3.5...v3.6
[3.5]: https://github.com/vlk-jan/simview/compare/v3.4...v3.5
[3.4]: https://github.com/vlk-jan/simview/compare/v3.3...v3.4
[3.3]: https://github.com/vlk-jan/simview/compare/v3.2...v3.3
[3.2]: https://github.com/vlk-jan/simview/compare/v3.1...v3.2
[3.1]: https://github.com/vlk-jan/simview/compare/v3.0...v3.1
[3.0]: https://github.com/vlk-jan/simview/releases/tag/v3.0
