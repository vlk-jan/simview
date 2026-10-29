# Performance findings from dataset_tools (2026-10-29)

Notes from tuning the HELHEST dataset viewer (`dataset_tools/viewer`), which builds
one SimView scene per viewing window and serves it as a static bundle
(`window.__simviewStaticBase`, `simview.columnar.write_static_bundle`) from its own
FastAPI app. Users reach it from a laptop over an SSH tunnel, so bytes and round
trips matter as much as CPU. Line numbers refer to the **6.4.0** sdist. This
checkout is at `dcc40b5`, which is behind the `v6.4.0` tag.

dataset_tools moved from 6.1.1 to 6.4.0 in the same session. What that move
needed, and what it measured, is under [Upgrade notes](#upgrade-notes-61160-64).

## The workload

One window is about 1500-8000 frames of one robot, with these bodies and data:

- a merged point cloud of ~400-600k points;
- a terrain grid of ~474k cells (1182 x 401) with 7 property layers;
- ~25 scalar series.

What a window costs:

- **Bundle on disk and over the wire:** 32.8 MB in 37 blobs with 6.1.1-6.4.0
  defaults. With `compute_normals=False` it is 25.7 MB raw, or 9.5 MB under deflate-6.
- **Build (warm files):** 1.35 s for scene 0031 and 2.14 s for scene 0005.
  0.9-1.1 s of that is SimView's own serialization: `add_trajectory` ~0.5 s,
  `columnarize_states` and the rest of `scene_document` 0.18-0.40 s, and
  `write_static_bundle` 0.18 s. The rest is the app's map splatting and file reads.
- **6.1.1, 6.3.1 and 6.4.0 build in identical times and write identical bytes.**
  Every release since 6.1.1 changed only the browser side for this workload.

The biggest blobs of one window, before dropping normals:

| Field | Bytes | deflate-1 | Notes |
|---|---|---|---|
| point cloud `points` (N, 3) float32 | 7.2 MB | 6.3 MB | positions barely compress |
| point cloud `color` (N, 3) float32 RGB | 7.2 MB | 0.98 MB | 8-bit data stored as float32 |
| terrain `normals` (3 floats/cell) | 5.7 MB | 2.8 MB | the browser can compute them |
| terrain `heightData` | 1.9 MB | 1.1 MB | |
| 7 terrain `properties` layers | 7 x 1.9 MB | 14 kB - 1.1 MB each | validity 0..2, driven 0/1, counts: small integers in float32 |

## Proposals, biggest first

### 1. A columnar authoring path that never builds per-frame dicts (Python, build time)

`add_trajectory` (scene.py:344) loops `for t in range(T)` (scene.py:440). For every
frame it builds a dict and encodes each body field as its own `__b64__` blob
(`encode`, scene.py:434; `_encode_blob`, model.py:15), about 39k blobs per window.
`columnarize_states` (columnar.py:213) then decodes them and re-packs whole-run
columns, re-encoding them as `__b64__`. `write_static_bundle` (columnar.py:463)
decodes once more to write raw files. So every byte goes through base64 three
times, and every frame becomes Python objects twice.

Proposal: let `add_trajectory` keep the `(T, B, k)` arrays as they come (it already
receives whole-run arrays), and emit columnar blobs straight from them in
`save(columnar=True)`, `save_static()` and `write_static_bundle`. In the static
path, write raw bytes from the arrays and skip base64 entirely.

Expected effect: most of the 0.9-1.1 s per window goes, roughly halving a build.
FUTURE_WORK.md's "`add_state` overhead" covers the same kind of cost on the
`add_state` path.

### 2. Compact blob dtypes (bytes over the wire)

Every blob is little-endian float32 today (`_encode_blob`, model.py:15; the reader
wraps every blob as `new Float32Array(await res.arrayBuffer())`, SimView.js:296).
A per-blob dtype (and, for quantised data, scale and offset) in the JSON would allow:

- **point colours as uint8 RGB:** 7.2 MB -> 1.8 MB;
- **terrain property layers as uint8/uint16** where the producer says so
  (categorical masks and counts): ~1.9 MB -> 0.47-0.95 MB each;
- **point positions as int16 with a per-cloud scale and offset** (1 cm over ±327 m):
  7.2 MB -> 3.6 MB;
- **heights as int16 with scale and offset** where millimetres are enough.

Together with item 3 this takes a window from ~26 MB to well under 10 MB raw.
Browser cost: one typed-array view per blob, plus a dequantise in the shader or once at load.

### 3. Fetch terrain property layers only when their colour mode is chosen

In static mode every model blob is fetched at load, all seven 1.9 MB property layers
included (`Terrain.#initProperties`, Terrain.js:43). Only one colour mode is shown at
a time, and most sessions never leave "height". Fetching a layer when its mode is
first selected (keep the URL, resolve it lazily) takes ~13 MB, half the bundle, off
the initial load.

### 4. Scalar point colour layers with a browser-side colour map

6.4.0's `create_pointcloud(color_layers=)` (model.py:491) takes extra `(N, 3)` RGB
layers, so each switchable colouring costs another 7.2 MB. dataset_tools offers
height and intensity colouring of the cloud, and today a switch means a separate
build and bundle (`cloud_color` build option). A layer given as one value per point
plus a colour-map name, coloured in the browser through the LUT path 6.4.0 added for
similarity (~9 ms per 200k points), would cost 2.4 MB as float32 or 0.6 MB as
uint8. It would make the switch instant with no rebuild.

### 5. Document the static-mode embedding path

Two of 6.3.1's load wins only work on SimView's own server:

- `/static` gzip (server.py:358);
- the filled `<!-- @modulepreload -->` placeholder (`preload.render_index`, used by
  server.py:535 and `static-viewer`).

An app that serves the bundle and SimView's assets itself gets neither unless it
knows to:

- **call `simview.preload.render_index`:** dataset_tools now does, which gives 51
  preload links;
- **gzip `/static`:** 2455 KB -> 570 KB according to the 6.3.1 changelog.

A short "embedding SimView" section in the docs, with the window events and fields
an embedder can rely on, would save the next embedder the dig.

### 6. Smaller observations

- **Static mode never windows state fields** (`windowLargeStateFields` returns at
  once, SimView.js:218-219). That's fine at these sizes, since the largest blob is
  7.2 MB and the 8 MB threshold is never crossed. But a static host's Range support
  is never used.
- **No browser-side caching beyond the HTTP cache:** there's no Cache API or
  IndexedDB. A revisited window re-validates ~40 URLs. Content-addressed blob URLs
  served `immutable` would let a host skip that. That's on the host, but SimView
  could name blobs by hash in `write_static_bundle` to make it easy.
- **No compression of blobs.** A host can't gzip blobs that are also served by Range
  without care. Precompressed `blob/N.gz` siblings from `write_static_bundle`, served
  whole when no Range is asked for, would cut a window from 25.7 MB to 9.5 MB on
  links where that matters. dataset_tools gets the same effect today from `ssh -C`.

## Upgrade notes (6.1.1 -> 6.4)

- **Undocumented removal:** `AnimationController.getCurrentStateIndex()` and
  `getCurrentTime()` were removed in 6.2.2 (commit `08b4530`); CHANGELOG.md does not
  mention it. Embedders reading the frame index broke silently, the dataset_tools
  overlay among them; it now reads the `currentStateIndex` property.
- **`setViewState` no longer pauses** unless `time` is present (6.2.0). dataset_tools
  carries views between windows without `time`, so paging no longer pauses playback.
- **`goToTime` clamps to `[firstTime, firstTime + totalTime]`.** Harmless for a
  timeline starting at 0.
- **`compute_normals=False` works well for this terrain:** shading from
  browser-computed normals looked right in headless Chromium, and the window shrank
  by 5.7 MB. The cost is that the "normals" arrow view has nothing to draw. A
  browser-side fallback that derives the arrows from the computed normals would
  remove that trade-off.
- **Measured nothing in the browser beyond a smoke test:** headless Chromium with
  software GL loaded a 25.3 MB window, from a warm cache, to `animationController.store`
  ready in 5.6 s, with no request failures. The 6.2.1 terrain-build and 6.3.1
  startup gains were not timed on this workload.
