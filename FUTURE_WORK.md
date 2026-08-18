# Future work

Carried over from the 2026-08-17 deep-dive review. Items 1–8 and 10 from that
review (in-memory scene mutation by the server, mesh-body rendering, dead
drag-selection code, silent blob-fetch failures, merge dropping
embeddingData/metadata + missing bounds validation, endian-safe state-field
decode, singleton terrain deduplication, live-mode RL-scale streaming, and
`simview diff`'s parent-relative pose mismatch) are already fixed — see the
commit history around this file's introduction, plus the "Smaller leftovers"
section below. What remains are the larger design items, aimed at making
SimView a universal viewer that also works at reinforcement-learning scale
(many envs, long/episodic runs), beyond the current primary consumer
(../DRIFT).

## 9. Make the columnar (v4) format a first-class on-disk format

The columnar layout only exists as a server-side repack: `save()` still writes
per-frame states with thousands of small base64 strings, and
`server.py::_columnarize_states` re-parses and re-packs them on every load.
Since `add_trajectory` already holds whole `(T, B, k)` arrays, writing the
columnar layout directly would:

- shrink files and make `SimulationScene.load` / `merge` much cheaper,
- remove the silent "falls back to legacy if frames aren't uniform" surprises
  (e.g. a body whose optional attribute appears mid-run — explicitly tolerated
  by `save()`'s attribute reconciliation — currently disqualifies the whole
  scene from columnarization with only a server log line to show for it),
- let the browser stream/window state data (see item 11) without the server
  holding everything in RAM (`self.blobs` + gzipped legacy states + model).

Needs a versioned `states` document shape on disk plus reader support in
`SimulationScene.load`, `merge`, `diff`/`terrain`/`info` CLI, and the viewer
(which already consumes the v4 shape over HTTP).

## 11. RL-scale data model: episodes, many envs, long runs

Everything currently assumes one continuous timeline per scene and one
world-space patch per batch:

- **Episode semantics.** RL runs are episodic (resets, variable lengths,
  per-episode returns). Consider an optional `episodes` section in the model,
  e.g. `[{"start_index": int, "label": str}, ...]`, with the playback bar
  showing episode boundaries, "next/previous episode" navigation, and the
  scalar plotter able to overlay per-episode aggregates (e.g. return). This
  touches the wire format, so design it together with item 9.
- **Batch = env count scaling.** The sqrt-grid batch layout
  (`BatchManager._initialize`) and per-batch THREE groups (terrain mesh, axes,
  vector arrows per batch in `Body.createBatchGroups`) will not scale to
  hundreds of envs. Wanted: a "render only focused batch(es)" mode (build
  scene objects lazily per visible batch), and instanced rendering for
  per-batch decorations.
- **Windowed state fetching.** For very long trajectories the browser
  materializes the entire run. With columnar-on-disk (item 9) the viewer could
  fetch time windows of the per-body blobs on demand (HTTP range requests or a
  windowed blob endpoint) and keep only a sliding window in memory.

## Smaller leftovers (from the same review)

Open:

- `interactionController`/hover: hovering an `InstancedMesh` would scale all
  batch instances at once — hover effects were removed with the dead selection
  code; if reintroduced, operate per-instance.

Done:

- ~~`BatchManager.setActiveBatch` still forwards an invalid index to
  `bodyStateWindow.setSelectedBatch` after warning.~~
- ~~`add_state` with a 0-dim scalar tensor stores a bare float.~~
- ~~CORS: `allow_credentials=True` with an any-localhost-port origin regex.~~
- ~~`SimulationScene._clear_internal_data` doesn't clear `embedding_data`.~~
- ~~CLAUDE.md's repo description predates `info.py`, `diff.py`, `terrain.py`,
  `render.py` and the `render` extra.~~ (CLAUDE.md is untracked and must not be
  committed — see its own commit guidelines — so the update lives only in the
  working tree.)
