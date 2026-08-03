// Pure, DOM-free terrain sampling logic for the Terrain analysis tab: bilinear
// grid sampling (mirrors `_bilinear_sample` in simview/terrain.py so the two
// stay numerically identical for the same input) plus a series builder that
// walks per-frame body positions against per-batch terrain grids.

// Whether any body in the scene actually has per-frame trajectory data
// (validStates > 0), as opposed to merely existing. A body defined in the
// model but never given add_state/add_trajectory (e.g. a static point-cloud
// export with no animation) sits at its default origin/identity pose
// forever -- the Terrain tab has nothing to plot a profile against for a
// path that doesn't exist, so SimView.js gates showing the tab on this
// rather than "does the scene have any body at all."
export function hasBodyTrajectory(bodies) {
    if (!bodies) return false;
    const iter = typeof bodies.values === "function" ? bodies.values() : bodies;
    for (const body of iter) {
        if ((body.validStates || 0) > 0) return true;
    }
    return false;
}

// Bilinearly samples a flat, row-major (row = y, column = x, per model.py's
// "column index is x" convention) grid at world point (x, y). Out-of-extent
// points are clamped to the nearest edge rather than extrapolated.
export function bilinearSample(grid, dimensions, bounds, x, y) {
    const { resolutionX: shapeX, resolutionY: shapeY } = dimensions;
    const { minX, maxX, minY, maxY } = bounds;

    let fx = maxX !== minX ? ((x - minX) / (maxX - minX)) * (shapeX - 1) : 0;
    let fy = maxY !== minY ? ((y - minY) / (maxY - minY)) * (shapeY - 1) : 0;

    if (fx < 0) fx = 0;
    else if (fx > shapeX - 1) fx = shapeX - 1;
    if (fy < 0) fy = 0;
    else if (fy > shapeY - 1) fy = shapeY - 1;

    const x0 = Math.floor(fx);
    const x1 = Math.min(x0 + 1, shapeX - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, shapeY - 1);
    const tx = fx - x0;
    const ty = fy - y0;

    const v00 = grid[y0 * shapeX + x0];
    const v10 = grid[y0 * shapeX + x1];
    const v01 = grid[y1 * shapeX + x0];
    const v11 = grid[y1 * shapeX + x1];

    return (
        v00 * (1 - tx) * (1 - ty) +
        v10 * tx * (1 - ty) +
        v01 * (1 - tx) * ty +
        v11 * tx * ty
    );
}

// Builds one {x: time, y: value}[] series per batch for a terrain layer.
//
// `paths`: per-batch array of per-frame [x, y] points (e.g. a body's world
// position history), one entry per batch. A frame entry may be null/
// undefined (or contain a non-finite coordinate) to mark that batch as
// having no body data at that frame -- such frames are simply omitted from
// the output series rather than producing a bogus sample.
// `grids`: per-batch flat row-major grid arrays for the layer being sampled,
// or a single-entry array when `isSingleton` (one terrain shared by every
// batch, see Terrain.js's `isSingleton`).
// `referenceBatch`: null samples each batch's own path against its own
// terrain ("own path" mode, the default); an index instead samples every
// batch's terrain along that one batch's path ("path of <batch>" mode), so a
// shared trajectory can be compared across terrains.
export function buildTerrainSeries({
    times,
    paths,
    grids,
    dimensions,
    bounds,
    isSingleton = false,
    referenceBatch = null,
}) {
    const numBatches = paths.length;
    const series = new Array(numBatches);
    for (let b = 0; b < numBatches; b++) {
        const pathBatch = referenceBatch === null ? b : referenceBatch;
        const path = paths[pathBatch];
        const grid = grids[isSingleton ? 0 : b];
        const points = [];
        if (path && grid) {
            const numFrames = Math.min(times.length, path.length);
            for (let s = 0; s < numFrames; s++) {
                const p = path[s];
                if (
                    !p ||
                    p.length < 2 ||
                    !Number.isFinite(p[0]) ||
                    !Number.isFinite(p[1])
                ) {
                    continue;
                }
                points.push({
                    x: times[s],
                    y: bilinearSample(grid, dimensions, bounds, p[0], p[1]),
                });
            }
        }
        series[b] = points;
    }
    return series;
}
