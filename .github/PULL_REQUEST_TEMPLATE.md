## Summary

<!-- What does this PR change, and why? -->

## Which surface does this touch?

- [ ] Python backend (`simview/`)
- [ ] Frontend (`simview/static/js/`)
- [ ] Wire format (`model`/`states` shape, binary encoding, columnar repack)
- [ ] Docs / CI / other

## Checklist

- [ ] `uv run pytest -q` passes
- [ ] `uv run ruff check .` and `uv run ruff format --check .` pass
- [ ] `uv run pyright` passes
- [ ] `npm test` passes (if frontend changed)
- [ ] If this changes serialization on either side, `README.md`'s "JSON Format
      Specification" is updated and both Python and JS sides stay in sync
- [ ] If this only works with `torch` installed, it still passes on a base
      install (no `authoring` extra) — see `test-base-install` in CI

## Test plan

<!-- How did you verify this? Manual steps, new/updated tests, etc. -->
