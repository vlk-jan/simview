# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/vlk-jan/simview/compare/v3.3...HEAD
[3.3]: https://github.com/vlk-jan/simview/compare/v3.2...v3.3
[3.2]: https://github.com/vlk-jan/simview/compare/v3.1...v3.2
[3.1]: https://github.com/vlk-jan/simview/compare/v3.0...v3.1
[3.0]: https://github.com/vlk-jan/simview/releases/tag/v3.0
