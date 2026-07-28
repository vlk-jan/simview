# SimView

**SimView** is a THREE.js-based 3D visualizer for physics simulations. It lets
you explore and compare multiple simulation scenarios ("batches") side by
side in a shared environment, defined either through a portable JSON format
or a Python API — all served over HTTP/WebSocket to a web-based interface
powered by [Three.js](https://threejs.org/).

## Two independent surfaces

SimView is split into two things you can use independently:

- **Viewing** an existing simulation JSON file — needs only the base install
  (`fastapi`, `uvicorn`, `orjson`, ...).
- **Authoring** simulations from Python (`simview.scene`/`state`/`model`) —
  needs the `authoring` extra (`torch`, `einops`, `numpy`).

If you only need to open a `.json`/`.json.gz` scene someone else produced, you
never need `torch` installed.

## Features

- **Batched simulations** — visualize multiple simulation instances
  side-by-side, sharing terrain where possible.
- **Interactive UI** — web-based controls for playback, camera, and
  per-body data inspection.
- **Python API** — build scenes incrementally or stream live state as a
  simulation runs.
- **Portable JSON format** — load/save simulation data as a single JSON
  document (optionally gzip-compressed), with a documented
  [wire format](dev/json-format.md) for interop with other languages.

## Where to go next

| I want to... | Go to |
|---|---|
| Try it in the browser right now, no install | [Live Demo](https://vlk-jan.github.io/assets/demos/simview/) |
| Install SimView and view/author my first scene | [Quick Start & Installation](usage/getting-started.md) |
| Use the `simview` CLI (inspect, query terrain, diff batches, render, merge) | [CLI Utilities](usage/cli.md) |
| Stream simulation state live as it runs | [Live Streaming](usage/live-streaming.md) |
| Use SimView from a Jupyter notebook | [Jupyter / Non-blocking Viewing](usage/jupyter.md) |
| Learn the viewer's keyboard shortcuts and panels | [Visualization Controls](usage/controls.md) |
| Look up a Python class or function | [API Reference](api/scene.md) |
| Understand how the pieces fit together, or the JSON wire format | [Developer Guide](dev/architecture.md) |

SimView is distributed under the [BSD 3-Clause License](https://github.com/vlk-jan/simview/blob/main/LICENSE).
