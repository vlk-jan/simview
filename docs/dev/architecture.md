# Architecture Overview

SimView has two halves that only talk to each other over HTTP and WebSocket:
a Python backend (FastAPI/uvicorn) that owns a scene's data — a static
`model` plus time-ordered `states` — and a vanilla-JS/THREE.js frontend that
renders it in the browser. Neither side needs to know the other's internals
beyond the [JSON wire format](json-format.md) they agree on.

```
Python (authoring or file-on-disk)           Browser
┌───────────────────────────┐   HTTP GET     ┌───────────────────────────┐
│ SimulationScene / JSON    │  ───────────▶  │ SimView.js (main.js)      │
│  - model (static)         │   /model       │  - loadData/fetchBlobs    │
│  - states (per-frame)     │   /states,     │  - StateStore, Scene,     │
│                           │   /blob/...    │    AnimationController    │
│ SimViewServer (FastAPI)   │  ◀──────────── │  - Controls, panels       │
│  - columnar (see below)   │   WebSocket    │                           │
│  - LiveViewer push_state  │   (live only)  │                           │
└───────────────────────────┘                └───────────────────────────┘
```

## Python backend (`simview/`)

- **`model.py`** — static scene definition: `SimViewModel`, `SimViewBody` (shape +
  optional `parent`/`localTransform` for rigid attachment), `SimViewStaticObject`,
  `SimViewTerrain`. Pure data/validation, no torch dependency at this layer beyond
  what's passed in.
- **`state.py`** — per-frame dynamic data: `SimViewBodyState` (one frame) and
  `BodyTrajectory` (a whole `(T, B, ...)` trajectory in one call, authoring-only,
  needs torch/numpy). Both can binary-encode numeric fields (`__b64__` + little-endian
  float32) instead of plain JSON lists — see [JSON Format Specification](json-format.md).
- **`scene.py`** — `SimulationScene`, the main authoring API: builds a model
  incrementally (`create_terrain`, `create_body`, ...), accumulates `states` via
  `add_state`/`add_trajectory`, and can `save()`/`load()` JSON (optionally gzipped)
  or `show()` a non-blocking viewer (returns a `ViewerHandle`, usable in Jupyter via
  `_repr_html_`).
- **`columnar.py`** — the columnar ("v4") states layout: one binary blob per body per
  field covering the whole trajectory, instead of thousands of small per-frame values.
  Both a wire format and (via `SimulationScene.save`) an on-disk one — the same document
  either way, with inline `__b64__` blobs on disk and `/blob/` URLs over HTTP.
  `columnarize_states` (the writer/repacker) needs numpy; `expand_columnar_states` (the
  inverse) is stdlib-only so every reader, including the base install and the
  stdlib-only CLI tools, can consume a columnar file.
- **`server.py`** — `SimViewServer`: FastAPI app serving `templates/index.html` and
  `static/`, plus `/model` and `/states` (or per-blob endpoints). A columnar file is
  served as-is (only its inline blobs are rewritten into URLs); a legacy per-frame file
  is repacked into the columnar payload at load time for much cheaper playback of long
  recordings, falling back to serving the per-frame array if the frames aren't uniform
  enough to columnarize. Also handles WebSocket live-push (see `live.py`) and
  batch-rename persistence.
- **`live.py`** — `LiveViewer`: starts the server immediately (on a background thread
  via `_ThreadedServer`) and streams `push_state` calls to connected browser tabs over
  WebSocket as a simulation runs, instead of saving-then-viewing after the fact.
- **`launcher.py`** — `SimViewLauncher`: blocking launch used by the CLI / `save`+view
  workflows (as opposed to `live.py`'s streaming launch or `scene.show()`'s
  non-blocking one).
- **`merge.py`** — `merge_simulation_files`: combines multiple scene JSON files
  (e.g. a real-world recording and a simulated rerun) that share the same bodies/terrain
  into one scene with extra batches, resampling every file but the first onto the
  first file's timeline by nearest timestamp.
- **`diff.py`** — per-frame position/orientation divergence between two batches,
  backing `simview diff`.
- **`terrain.py`** — bilinear-interpolated point/area terrain queries, backing
  `simview terrain`.
- **`info.py`** — structural summary (body/terrain/state breakdown, consistency
  warnings), backing `simview info`.
- **`render.py`** — headless PNG screenshots via a real (headless) browser driving a
  real `SimViewServer` instance, backing `simview render`.
- **`utils.py`** — small shared helpers (e.g. free-port lookup, gzip-transparent file
  reads).
- **`__main__.py`** — CLI entry point (`simview` script): view file(s), `simview
  info`/`terrain`/`diff`/`render`, `simview clear` cache cleanup, `--save-merged`.

### Lazy imports

`simview/__init__.py` only imports authoring symbols (`SimulationScene`,
`SimViewBody`, etc.) on first attribute access, via a module-level `__getattr__`
that looks each name up in a `_LAZY_EXPORTS` table. This keeps `import simview`
torch-free for viewing-only installs — a viewing-only install can `import simview`
and use `SimViewServer`/CLI features without ever needing `torch`/`einops`/`numpy`
installed, and only pays that import cost (and dependency requirement) the moment
an authoring symbol like `SimulationScene` is actually touched.

## Frontend (`simview/static/js/`)

Vanilla JS ES modules (no bundler/framework), loaded via `templates/index.html`'s
importmap. Entry point `main.js` → `SimView.js` (`SimView` class), which owns startup
(`loadData`/`fetchBlobs`/`initFromModel`) and wires everything else together:

- **`components/`** — `Scene` (THREE.js scene/camera/renderer), `StateStore` (decoded
  trajectory data + playback lookups), `AnimationController` (playback loop, speed,
  interpolation), `BatchManager` (per-batch color/focus/visibility), `InteractionController`
  - `InteractionControls` (camera/mouse/keyboard).
- **`objects/`** — THREE.js object wrappers: `Body`, `StaticObject`, `Terrain` (heightfield
  mesh + friction/stiffness/click-to-similarity "features" color modes), plus shared
  helpers in `utils.js`. `colormap.js`/`similarity.js` factor the colormap resolver and
  cosine-similarity math out of `utils.js` (which pulls in the browser-only `chroma`
  package) into small, dependency-light modules used by both `Body`'s
  click-to-similarity point coloring and `Terrain`'s "features" mode.
- **`ui/`** — DOM-based UI panels: `Controls` (main options panel), `PlaybackControls`,
  `BodyStateWindow`, `Legend`/`BatchLegend`, `ScalarPlotter` and `ErrorMetrics` (both
  behind `AnalysisPanel`'s tab switcher, both plotted with vendored uPlot).
- **`utils/`** — pure logic factored out for unit testing without a DOM/THREE.js:
  `blobCodec.js` (decode the server's columnar float32 blobs — must stay in sync with
  the server's repack logic), `bodyTransforms.js` (resolve parent-relative poses,
  `topoSortBodies`), `interpolate.js`, `errorMath.js`, `csv.js`, `viewState.js`
  (encode/decode the shareable view-link URL hash), `liveFollow.js` (should new live
  frames auto-scroll playback), `terrainSample.js` (bilinear terrain layer sampling for
  the Analysis panel's Terrain tab, plus `hasBodyTrajectory` gating whether that tab
  shows up for a given body), `episodes.js` (episode segments, navigation and
  per-episode aggregates), `batchVisibility.js` (which batches get built and drawn),
  `blobWindow.js` (window arithmetic for range-fetching a long trajectory's field blobs,
  used by `components/WindowedField.js`).

### Vendored third-party libraries

[**uPlot**](https://github.com/leeoniya/uPlot) (MIT), [**three.js**](https://github.com/mrdoob/three.js)
(MIT), and [**chroma-js**](https://github.com/gka/chroma.js) (MIT) are vendored under
`simview/static/lib/` (version-stamped directories, e.g. `lib/three-0.174.0/`) rather
than loaded from a CDN, so the viewer works fully offline. All third-party libraries
used by SimView are permissively licensed (MIT/BSD), so there are no licensing
restrictions on commercial use. Don't add new CDN-loaded dependencies without a reason
to break that pattern.

## Wire format

Python and JavaScript agree on the `model`/`states` JSON shape, binary field encoding,
parent-relative bodies, and the columnar layout independently — there is no shared
schema file. See [JSON Format Specification](json-format.md) for the full contract;
read it before changing anything that touches serialization on either side
(`model.py`/`state.py`/`server.py` in Python, `blobCodec.js`/`bodyTransforms.js` in JS).

## Project structure

```
simview/
├── simview/                # Python package
│   ├── model.py             # SimViewModel, SimViewBody, SimViewStaticObject, SimViewTerrain
│   ├── state.py             # SimViewBodyState, BodyTrajectory
│   ├── scene.py             # SimulationScene, ViewerHandle
│   ├── columnar.py          # columnar ("v4") states layout (wire + on disk)
│   ├── server.py            # SimViewServer (FastAPI app, columnar repack)
│   ├── live.py               # LiveViewer, _ThreadedServer
│   ├── launcher.py           # SimViewLauncher
│   ├── merge.py               # merge_simulation_files
│   ├── diff.py                 # simview diff backend
│   ├── terrain.py              # simview terrain backend
│   ├── info.py                  # simview info backend
│   ├── render.py                 # simview render backend (Playwright)
│   ├── utils.py                   # shared helpers
│   ├── __main__.py                 # simview CLI entry point
│   ├── templates/                   # index.html
│   └── static/
│       ├── css/
│       ├── js/
│       │   ├── main.js               # entry point
│       │   ├── SimView.js             # top-level SimView class
│       │   ├── components/
│       │   ├── objects/
│       │   ├── ui/
│       │   └── utils/
│       ├── lib/                       # vendored three.js, chroma-js, uPlot, ...
│       └── textures/
├── tests/                    # pytest suite (+ tests/js/ vitest, tests/e2e/ Playwright)
├── example.py                 # authoring example (see Quick Start)
├── example_live.py             # LiveViewer example
├── mkdocs.yml                    # this documentation site
├── docs/                          # documentation source
└── pyproject.toml                  # package metadata, ruff/pyright config, uv dependency-groups
```
