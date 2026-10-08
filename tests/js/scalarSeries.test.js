import { describe, expect, it } from "vitest";
import { StateStore } from "../../simview/static/js/components/StateStore.js";

import { appendScalarFrames } from "../../simview/static/js/utils/scalarSeries.js";

describe("appendScalarFrames (live-mode scalar plot growth)", () => {
    it("pulls only the frames past `from` into the series and uPlot columns", () => {
        const store = StateStore.fromLegacy([
            { time: 0, energy: [1, 2] },
            { time: 1, energy: [3, 4] },
        ]);
        const times = [0];
        const series = new Map([["energy", [[{ x: 0, y: 1 }], [{ x: 0, y: 2 }]]]]);
        const columns = new Map([["energy", [[1], [2]]]]);

        store.append([{ time: 2, energy: [NaN, 6] }]);
        const n = appendScalarFrames(store, ["energy"], 2, times, series, columns, 1);

        expect(n).toBe(3);
        expect(times).toEqual([0, 1, 2]);
        expect(series.get("energy")[0]).toEqual([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: NaN }]);
        expect(columns.get("energy")).toEqual([[1, 3, null], [2, 4, 6]]);
    });
});
