# Quick Start & Installation

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
