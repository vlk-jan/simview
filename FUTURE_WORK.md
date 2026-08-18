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
The per-batch decorations themselves are still one THREE object each when
everything *is* drawn: `AxesHelper` and the vector arrows per batch in
`Body.createBatchGroups`, and one `Points` per batch for point-cloud bodies.

Instancing those (an `InstancedMesh` for the arrows, a merged `LineSegments` for
the axes) would make "Render All Batches" usable at high batch counts too. Only
worth doing if that mode turns out to be something people actually want at those
counts — the focused view may simply be the right answer.

## Smaller leftovers

- `interactionController`/hover: hovering an `InstancedMesh` would scale all
  batch instances at once — hover effects were removed with the dead selection
  code; if reintroduced, operate per-instance.
