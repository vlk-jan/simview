# Future work

Carried over from the 2026-08-17 deep-dive review. Items 1–7 from that review
(in-memory scene mutation by the server, mesh-body rendering, dead drag-selection
code, silent blob-fetch failures, merge dropping embeddingData/metadata +
missing bounds validation, endian-safe state-field decode, singleton terrain
deduplication) are already fixed — see the commit history around this file's
introduction. What remains are the larger design items, aimed at making SimView
a universal viewer that also works at reinforcement-learning scale (many envs,
long/episodic runs), beyond the current primary consumer (../DRIFT).

## 8. Live mode won't survive RL-scale streaming

Current behavior and why it's a problem:

- `LiveViewer.push_state` (`simview/live.py`) blocks the **caller's** thread on
  `future.result(timeout=5.0)` for every frame. A slow or hung browser tab can
  stall the training/simulation loop by up to 5 s per pushed frame.
- `SimViewServer.frame_buffer` grows without bound, and the catch-up message for
  a newly connected client is one giant `json.dumps` of every frame so far
  (`server.py`, `/ws/states` handler).
- On every received chunk the viewer rebuilds **all** trails from scratch:
  `SimView.processStatesChunk` → `appendBodyHistories` → `Body.finalizeTrails`
  disposes and reallocates O(validStates) geometry per chunk, making a long live
  run O(T²) overall.

Suggested direction:

- Decouple sim from viz: a bounded queue + background sender thread in
  `LiveViewer` (fire-and-forget from the caller's perspective), with an explicit
  drop/decimation policy when the queue backs up (e.g. keep every Nth frame).
- Chunk the catch-up replay (send the buffered history in slices, or serve it
  via the existing HTTP `/states` machinery instead of one websocket message).
- Make trails append-only: pre-grow the trail buffer (the position history
  already doubles capacity in `Body.appendHistoryPointAt`) and extend
  `setDrawRange` instead of dispose-and-rebuild per chunk.

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

## 10. `simview diff` vs. browser Error Metrics disagree for parented bodies

`simview diff` (`simview/diff.py`) compares raw wire `bodyTransform`s, which for
an articulated child (a body with `parent` set but no `localTransform`) is the
**parent-relative local** pose. The browser resolves parent chains to world
poses first (`SimView.appendBodyHistories` → `resolveStateBodies` in
`static/js/utils/bodyTransforms.js`) before computing errors, so the same scene
yields different numbers in the two tools. Either resolve parent chains in
`diff.py` (duplicating the compose logic — quat multiply + rotate-translate —
in stdlib-only Python, consistent with that module's dependency-free rule) or
document the difference loudly in `--help` and the docs. Resolving is
preferred; rigidly-attached bodies (constant `localTransform`) never appear in
states at all, so today they silently can't be diffed either.

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

- `interactionController`/hover: hovering an `InstancedMesh` would scale all
  batch instances at once — hover effects were removed with the dead selection
  code; if reintroduced, operate per-instance.
- `BatchManager.setActiveBatch` still forwards an invalid index to
  `bodyStateWindow.setSelectedBatch` after warning.
- `add_state` with a 0-dim scalar tensor stores a bare float (`.tolist()` of a
  0-dim tensor); `merge`'s `values.extend(scalar_values)` would then crash.
  Normalize scalars to lists at ingestion.
- CORS: `allow_credentials=True` with an any-localhost-port origin regex means
  any local dev server can read scene data; credentials aren't needed — drop
  the flag.
- `SimulationScene._clear_internal_data` clears heights/normals/properties but
  not `embedding_data`.
- CLAUDE.md's repo description predates `info.py`, `diff.py`, `terrain.py`,
  `render.py` and the `render` extra.
