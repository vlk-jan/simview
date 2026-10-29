# Future work

The 2026-08-17 deep-dive review's items are all addressed — see the commit
history around this file's introduction. What follows is what that work
deliberately left open, plus the one leftover it never covered.

## Windowing the whole-run consumers

`velocity`/`angularVelocity`/`force`/`torque` are now range-fetched in windows
around the playhead (`static/js/utils/blobWindow.js`,
`components/WindowedField.js`), because they're only ever read for the frame on
screen. `bodyTransform` and the scalars are still materialized in full, and for
a very long run they're the remaining ceiling.

They can't simply be windowed too: every whole-run consumer walks them from
frame 0 —

- `SimView.appendBodyHistories` builds each body's `positionHistory` /
  `quaternionHistory` over the entire timeline (trails, `ErrorMetrics`,
  `TerrainProfile` all read from it),
- `ScalarPlotter.initFromStore` pulls each scalar's whole series for its plots.

So dropping peak memory further means giving those consumers a windowed or
downsampled view of their own — e.g. decimating the trail/plot data to screen
resolution and refining on zoom, rather than keeping one point per frame. That's
a redesign of those panels, not a change to the fetch layer, and it should be
driven by a real recording that actually hurts rather than done speculatively.

## Instanced per-batch decorations

`BatchManager`'s focused-batch mode means a scene with hundreds of envs only
builds and draws one batch's objects, which was the scaling problem in practice.
(Terrain still builds a heightfield mesh per batch up front, but its normal
arrows are now created lazily.)
The per-batch decorations themselves are still one THREE object each when
everything *is* drawn: `AxesHelper` and the vector arrows per batch in
`Body.createBatchGroups`, and one `Points` per batch for point-cloud bodies.

Instancing those (an `InstancedMesh` for the arrows, a merged `LineSegments` for
the axes) would make "Render All Batches" usable at high batch counts too. Only
worth doing if that mode turns out to be something people actually want at those
counts — the focused view may simply be the right answer.

## `add_state` overhead

Measured 2026-10-19 on 5000 steps × 64 envs × 4 bodies (70 MB file, median of
3): `add_state` loop 2.7 s, `add_trajectory` 0.34 s, `save` 0.8 s, server load
0.22 s, viewer ready 1.4 s (vs 0.7 s for the tiny example). Only `add_state`
stands out: `SimViewBodyState` converts tensors to lists, concatenates them, and
`to_json` turns them back into an array to pack the blob — ~1 s of the 2.7 s.
Packing straight from the arrays would roughly halve it, but `position`/
`orientation` are public list attributes, and ~0.5 ms/frame is likely small
next to the sim step being recorded. Left alone until someone reports slow
recording; `add_trajectory` is the fast path for long runs.

## Bundle size and build time for per-window viewers (dataset_tools, 2026-10-29)

Found while tuning the HELHEST dataset viewer (`dataset_tools/viewer`). It builds
one SimView scene per viewing window and serves it as a static bundle from its own
FastAPI app, to a laptop over an SSH tunnel, so bytes and build time are what the
user waits on. A typical window has 1500-8000 frames of one robot, a merged point
cloud of ~400-600k points, a 1182 x 401 terrain with 7 property layers, and ~25
scalar series. With default options that comes to 32.8 MB in 37 blobs, and a
build takes 1.35-2.1 s, of which 0.9-1.1 s is SimView's own serialization.

The biggest blobs:

| Field | Bytes | deflate-1 | Notes |
|---|---|---|---|
| point cloud `points` (N, 3) float32 | 7.2 MB | 6.3 MB | positions barely compress |
| point cloud `color` (N, 3) float32 RGB | 7.2 MB | 0.98 MB | 8-bit data stored as float32 |
| terrain `normals` | 5.7 MB | 2.8 MB | can be dropped: `compute_normals=False` |
| terrain `heightData` | 1.9 MB | 1.1 MB | |
| 7 terrain `properties` layers | 7 x 1.9 MB | 14 kB - 1.1 MB each | small integers in float32; now fetched lazily |

Already done: property layers are fetched on first use, the normal arrows work
without shipped normals, and the embedding docs cover `render_index` and gzip for
`/static`. Still open, biggest first:

### Columnar authoring path

`add_trajectory` loops over frames (`scene.py`, `for t in range(T)`). For each frame
it builds a dict and encodes every body field as its own `__b64__` blob, about 39k
blobs per window. `columnarize_states` decodes them and re-packs whole-run
columns, and `write_static_bundle` decodes once more to write the raw files. So
every byte goes through base64 three times, and every frame becomes Python
objects twice. `add_trajectory` already receives `(T, B, k)` arrays. Keeping them
as they are and writing columnar blobs straight from them in `save(columnar=True)`,
`save_static()` and `write_static_bundle` (raw bytes, no base64, on the static path)
should cut most of the 0.9-1.1 s, roughly halving a build. It's the same kind of
cost as "`add_state` overhead" above.

### Compact blob dtypes

Every blob is little-endian float32 (`_encode_blob` in `model.py`; `fetchBlob` in
`SimView.js` wraps every response as a `Float32Array`). A dtype on each blob (plus
scale and offset for quantized data) would allow:

- uint8 point colors: 7.2 MB -> 1.8 MB;
- uint8/uint16 terrain property layers, for categorical masks and counts:
  1.9 MB -> 0.47-0.95 MB each;
- int16 point positions with a per-cloud scale and offset (1 cm over ±327 m):
  7.2 MB -> 3.6 MB;
- int16 heights where millimetres are enough.

This takes a window from ~26 MB to under 10 MB raw. It changes the scene format,
so it needs a format version bump, and readers (including `simview info`/`diff`
and the columnar tools) must learn the new dtypes.

### Scalar point color layers

`create_pointcloud(color_layers=)` takes only `(N, 3)` RGB, so each switchable
coloring of a 600k-point cloud costs another 7.2 MB, and dataset_tools rebuilds
the bundle to switch between height and intensity coloring. A layer given as one
value per point plus a colormap name, colored in the browser through the LUT path
similarity already uses (~9 ms per 200k points), would cost 2.4 MB as float32 or
0.6 MB as uint8, and switching would be instant. Pairs naturally with compact dtypes.

### Static-hosting extras

- Static mode never windows state fields (`windowLargeStateFields` returns early).
  The largest blob in these windows is 7.2 MB, under the 8 MB threshold, so this
  doesn't matter yet. A static host with Range support could allow it.
- `write_static_bundle` could name blobs by content hash, so a host can serve them
  `immutable` and a revisited window skips ~40 revalidations.
- Precompressed `blob/N.gz` siblings, served whole when no Range is asked for, would
  cut a window from 25.7 MB to 9.5 MB on slow links. dataset_tools gets the same
  effect today from `ssh -C`.

None of these were timed in a browser beyond a smoke test: a 25.3 MB window loaded
in 5.6 s in headless Chromium with software GL, from a warm cache.

## Smaller leftovers

- `interactionController`/hover: hovering an `InstancedMesh` would scale all
  batch instances at once — hover effects were removed with the dead selection
  code; if reintroduced, operate per-instance.
