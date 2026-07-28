# Contributing

## Prerequisites

- Python 3.12+
- [`uv`](https://docs.astral.sh/uv/) (this repo's package manager)
- Node 22+ (only needed for the JS unit tests and Playwright e2e test)

## Getting the code

```bash
git clone git@github.com:vlk-jan/simview.git
cd simview
```

## Setting up the development environment

```bash
uv sync --extra authoring --group dev
npm ci
```

`--extra authoring` installs `torch`/`einops`/`numpy`, needed to run the full test
suite (some tests are authoring-only and skip cleanly without it, see
[Testing](testing.md)).

## Running the tests

```bash
uv run pytest -q                                    # Python
uv run pytest --cov=simview --cov-report=term-missing --cov-fail-under=83 -q
npm test                                             # JS unit tests
uv run python example.py --no-launch && npx playwright test  # e2e smoke test
```

See [Testing](testing.md) for more detail on what each suite covers.

## Running the docs locally

```bash
uv sync --extra authoring --group docs
uv run mkdocs serve    # http://127.0.0.1:8000, live-reloads on edits
uv run mkdocs build    # static build to site/
```

## Code style

```bash
uv run ruff check .                # lint
uv run ruff format --check .       # format check (uv run ruff format . to fix)
uv run pyright                     # type check
```

`tests/*.py` has a project-wide ruff `E402` exemption, since torch-dependent test
modules put `pytest.importorskip("torch")` before the imports it guards (see
[Testing](testing.md)) — follow the same pattern in new torch-dependent test modules
rather than disabling the check per-file.

## Submitting changes

1. Branch from `main`.
2. Keep tests, lint, and type checks clean (`uv run pytest`, `uv run ruff check .`,
   `uv run ruff format --check .`, `uv run pyright`, and `npm test`/`npx playwright test`
   for frontend changes).
3. Write commit messages in the imperative mood ("Fix bug", not "Fixed bug"), prefixed
   with the type of change (`feat:`, `fix:`, `chore:`, ...). Keep unrelated changes out
   of a single commit; use partial file commits where useful.
4. Open a pull request against `main`.
