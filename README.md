# SimView Visualizer

[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue.svg)](https://vlk-jan.github.io/simview/)
[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen.svg)](https://vlk-jan.github.io/simview/demo/)

**SimView** is a powerful and interactive tool for visualizing 3D models and terrain data in simulations. It enables you to explore and analyze multiple simulation scenarios (batches) within a shared environment, all defined through an intuitive JSON format or a Python API.

Whether you're simulating physical objects or comparing different runs, SimView provides a flexible and efficient way to bring your data to life using a web-based interface powered by Three.js.

---

## Documentation

Full documentation — usage guides, CLI reference, the JSON format specification,
the API reference, and developer/architecture docs — is available at:

**[https://vlk-jan.github.io/simview/](https://vlk-jan.github.io/simview/)**

Want to try it without installing anything? There's a
[live browser demo](https://vlk-jan.github.io/simview/demo/)
(always up-to-date with the current code, no backend needed).

---

## Features

- **Batched Simulations**: Visualize multiple simulation instances side-by-side.
- **Shared Terrain**: Efficient rendering with shared terrain across all batches.
- **Interactive UI**: Web-based controls for playback, camera, and data inspection.
- **Python API**: Easy-to-use API for generating scenes and launching the visualizer directly from your code.
- **JSON Support**: Load and save simulation data using a portable JSON format.
- **Remote Files**: Open a scene straight off a compute host with `simview host:path/to/scene.json` — fetched over SSH, compressed on the wire, and cached locally.
- **Comparing Runs**: Merge several scene files into one, taking whole files or just picked batches — `simview gt.json method_a.json#1 method_b.json#1`.

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

### From PyPI

To only view existing simulation JSON files:

```bash
pip install simview
```

To also author simulations from Python (installs `torch` and `einops`):

```bash
pip install "simview[authoring]"
```

### From source

For working on SimView itself (or to track an unreleased commit), install an
editable checkout instead:

```bash
pip install -e .              # viewing only
pip install -e ".[authoring]" # viewing + authoring
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

## License

SimView is distributed under the [BSD 3-Clause License](LICENSE). The web interface
vendors [uPlot](https://github.com/leeoniya/uPlot), [three.js](https://github.com/mrdoob/three.js),
and [chroma-js](https://github.com/gka/chroma.js) (all MIT licensed) under
`simview/static/lib/` so the viewer works fully offline — see the
[documentation](https://vlk-jan.github.io/simview/dev/architecture/#vendored-third-party-libraries)
for details. All third-party libraries used by SimView are permissively licensed
(MIT/BSD), so there are no licensing restrictions on commercial use.
