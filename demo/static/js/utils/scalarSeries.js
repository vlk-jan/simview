// Pure scalar-series growth for ui/ScalarPlotter.js, kept DOM/uPlot-free so
// it can be unit-tested (tests/js/scalarSeries.test.js).

// Pulls frames [from, store.length) into the plotter's per-batch {x, y}
// series and uPlot columns in place, returning the new frame count. Live
// streaming appends a frame at a time, so this is O(new frames), not a
// whole-trajectory rebuild per push.
export function appendScalarFrames(store, scalarNames, batchSize, times, seriesByName, columnsByName, from) {
    for (let i = from; i < store.length; i++) {
        const frame = store.getFrame(i);
        const t = store.timeAt(i);
        times.push(t);
        for (const name of scalarNames) {
            const values = frame[name];
            const series = seriesByName.get(name);
            const columns = columnsByName.get(name);
            for (let b = 0; b < batchSize; b++) {
                const y = values?.[b];
                series[b].push({ x: t, y });
                columns[b].push(Number.isFinite(y) ? y : null);
            }
        }
    }
    return store.length;
}

