import { describe, expect, it } from "vitest";
import { isVisibleAt } from "../../simview/static/js/utils/visibleRanges.js";

describe("isVisibleAt", () => {
    it("is always visible without ranges", () => {
        expect(isVisibleAt(null, 3)).toBe(true);
        expect(isVisibleAt([], 3)).toBe(true);
    });

    it("is visible inside any range, bounds inclusive", () => {
        const ranges = [
            [0, 1],
            [5, 7.5],
        ];
        expect(isVisibleAt(ranges, 0)).toBe(true);
        expect(isVisibleAt(ranges, 1)).toBe(true);
        expect(isVisibleAt(ranges, 3)).toBe(false);
        expect(isVisibleAt(ranges, 7.5)).toBe(true);
        expect(isVisibleAt(ranges, 8)).toBe(false);
    });
});
