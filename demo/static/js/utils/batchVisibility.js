// Which batches actually get rendered.
//
// Every batch is laid out as its own patch of world (see BatchManager's sqrt
// grid), each with its own terrain mesh, per-batch groups, axes, arrows and
// point clouds. That's fine for a handful of batches and hopeless for the
// hundreds of parallel envs an RL run produces -- so the viewer can render
// only the batch you're looking at, and build the per-batch scene objects for
// the others lazily (never, if you never focus them).
//
// Pure functions, no DOM/THREE, so the policy is unit-testable on its own
// (tests/js/batchVisibility.test.js) and BatchManager just applies it.

export const RENDER_ALL = "all";
export const RENDER_FOCUSED = "focused";

// Above this many batches, "focused" is the default: a scene with hundreds of
// envs is unusable (and slow to even build) when everything is drawn at once,
// and the grid is far too dense to read anyway. Below it, showing everything
// is the more useful default and costs little.
export const AUTO_FOCUS_THRESHOLD = 32;

export function defaultRenderMode(simBatches) {
    return simBatches > AUTO_FOCUS_THRESHOLD ? RENDER_FOCUSED : RENDER_ALL;
}

// The set of batch indices to render. In "focused" mode that's the active
// batch plus any extras a comparison view needs (split-screen's two batches,
// the error-metrics pair, ...) -- passed in as `pinned` so this module doesn't
// have to know about those features.
export function visibleBatchSet(mode, simBatches, activeBatch, pinned = []) {
    if (mode !== RENDER_FOCUSED) {
        return new Set(Array.from({ length: simBatches }, (_, i) => i));
    }
    const visible = new Set();
    const add = (index) => {
        if (Number.isInteger(index) && index >= 0 && index < simBatches) {
            visible.add(index);
        }
    };
    add(activeBatch);
    pinned.forEach(add);
    // Never render nothing: an out-of-range active batch would otherwise blank
    // the scene entirely.
    if (visible.size === 0 && simBatches > 0) visible.add(0);
    return visible;
}
