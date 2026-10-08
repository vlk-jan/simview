import { describe, expect, it } from "vitest";
import { batchColumnsCsv, closestSeries, finiteBounds } from "../../simview/static/js/ui/chartControls.js";

describe("closestSeries", () => {
    const u = { data: [[0, 1], [1, 5], [null, 3], [4, 4]] };

    it("returns the 0-based batch closest to the y value, skipping gaps", () => {
        expect(closestSeries(u, 0, 3.9)).toBe(2);
        expect(closestSeries(u, 1, 3.1)).toBe(1);
    });

    it("returns -1 when no series has a value", () => {
        expect(closestSeries({ data: [[0], [null]] }, 0, 1)).toBe(-1);
    });
});

describe("batchColumnsCsv", () => {
    it("writes time plus one column per batch, blank where a point is missing", () => {
        const batchManager = { simBatches: 2, getBatchName: (b) => (b === 0 ? "gt" : "") };
        const csv = batchColumnsCsv(batchManager, [0, 0.5], [[{ y: 1 }, { y: 2 }], [{ y: 3 }]]);
        expect(csv.trim().split(/\r?\n/)).toEqual(["time,gt,batch_1", "0,1,3", "0.5,2,"]);
    });

    it("writes a null gap point as a blank cell", () => {
        const batchManager = { simBatches: 1, getBatchName: () => "a" };
        const csv = batchColumnsCsv(batchManager, [0, 1], [[{ y: 1 }, { y: null }]]);
        expect(csv.trim().split(/\r?\n/)).toEqual(["time,a", "0,1", "1,"]);
    });
});

describe("finiteBounds", () => {
    it("ignores NaN gaps and handles all-negative series", () => {
        expect(finiteBounds([[{ y: -3 }, { y: NaN }, { y: -1 }], [{ y: -2 }]])).toEqual([-3, -1]);
    });

    it("falls back to [0, 1] when nothing is finite", () => {
        expect(finiteBounds([[{ y: NaN }]])).toEqual([0, 1]);
    });
});
