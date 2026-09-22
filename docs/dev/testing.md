# Testing

SimView has three independent test suites: Python (pytest), JS unit tests (vitest),
and Playwright end-to-end tests.

## Python tests (`tests/`)

```bash
uv run pytest -q                                    # full suite
uv run pytest tests/test_scene.py -q                # one file
uv run pytest tests/test_scene.py::test_name -q     # one test
uv run pytest --cov=simview --cov-report=term-missing --cov-fail-under=83 -q
```

Tests requiring `torch` use `pytest.importorskip("torch")` before torch-dependent
imports (see `tests/conftest.py`'s `HAS_TORCH` flag), which pushes those imports below
a statement — hence the `tests/*.py` ruff `E402` ignore in `pyproject.toml`. Follow the
same pattern for new torch-dependent test modules so they skip cleanly on a base
install (no `authoring` extra).

`tests/conftest.py`'s `build_scene()` is the shared fixture builder for a small
representative scene (shared terrain + one box, a few states with an `"energy"`
scalar) — prefer it over hand-rolling scenes in new tests.

Test files are grouped roughly by area:

- **Core authoring**: `test_scene.py`, `test_trajectory.py`, `test_roundtrip.py`,
  `test_contacts.py`, `test_episodes.py`, `test_pointcloud_features.py`,
  `test_columnar_states.py`, `test_columnar_ondisk.py`
- **CLI-backed queries**: `test_terrain.py`, `test_terrain_query.py`, `test_diff.py`,
  `test_info.py`, `test_cli.py`
- **Server/viewer lifecycle**: `test_server.py`, `test_live.py`, `test_launcher.py`,
  `test_show.py`
- **Multi-file workflows**: `test_merge.py`, `test_batch_selection.py`
- **Shared helpers**: `test_utils.py`, `test_remote.py`

## JS unit tests (`tests/js/`)

```bash
npm test                                             # vitest run
npx vitest run tests/js/blobCodec.test.js            # one file
```

Target pure logic in `utils/` and a few `components/`/`objects/`/`ui/` classes — no
DOM/browser needed, run under Node. One `*.test.js` per module covered: `blobCodec`,
`blobWindow`, `bodyTransforms`, `interpolate`, `errorMath`, `csv`, `viewState`,
`liveFollow`, `episodes`, `terrainSample`, `batchPresets`, `batchVisibility`,
`cameraRange`, `similarity`, `objectsUtils`, `AnimationController`, `StateStore`,
`BatchManager`, `WindowedField`, `InteractionController`, `Body`, `Terrain`,
`TerrainFeatures`.

## End-to-end tests (`tests/e2e/`)

```bash
uv run python example.py --no-launch   # writes example_sim.json first
npx playwright test                     # auto-starts the server
npx playwright test tests/e2e/smoke.spec.js   # one spec
```

`tests/e2e/smoke.spec.js` is a tripwire for wiring-level regressions (bad imports,
server 500s), not a substitute for unit coverage — see the comment in
`playwright.config.js`. Alongside it, `batchVisibility`, `episodes`, `scalarChart`
and `windowedFields` cover behavior that only shows up in a real browser (per-batch
objects built lazily, episode navigation, a chart actually painting its data, range
requests for a long trajectory's fields). `playwright.config.js` starts two servers
for these: one on `example_sim.json`, one on the episodic scene
`make_episodic_scene.py` generates.

## CI

`.github/workflows/ci.yml` runs four independent jobs on every push/PR:

1. **Python** (matrix 3.12/3.13/3.14) — lint (`ruff check`), format check
   (`ruff format --check`), type check (`pyright`), and `pytest` with coverage,
   installed via `uv sync --extra authoring`.
2. **JS unit tests** — `npm test`.
3. **Playwright e2e** — generates `example_sim.json`, then runs the e2e specs.
4. **Base-install-only** — `uv sync` (no `authoring` extra), confirms `import simview`
   and the test suite still work without torch/numpy. A change that only works
   with `torch` installed will pass every other job but fail this one.
