import { describe, expect, it } from "vitest";
import { cameraRangeForBounds } from "../../simview/static/js/utils/cameraRange.js";

const DEFAULTS = { far: 500, maxDistance: 500 };

describe("cameraRangeForBounds", () => {
    it("keeps the configured defaults when there are no usable bounds", () => {
        expect(cameraRangeForBounds(null, DEFAULTS)).toEqual(DEFAULTS);
        expect(cameraRangeForBounds(undefined, DEFAULTS)).toEqual(DEFAULTS);
        expect(cameraRangeForBounds({}, DEFAULTS)).toEqual(DEFAULTS);
    });

    it("ignores bounds with non-finite or missing edges rather than producing NaN", () => {
        const partial = { minX: 0, maxX: 10, minY: 0 };
        const bad = { minX: 0, maxX: Number.NaN, minY: 0, maxY: 10 };
        expect(cameraRangeForBounds(partial, DEFAULTS)).toEqual(DEFAULTS);
        expect(cameraRangeForBounds(bad, DEFAULTS)).toEqual(DEFAULTS);
    });

    it("treats a degenerate (zero-area) extent as no information", () => {
        const point = { minX: 5, maxX: 5, minY: 5, maxY: 5 };
        expect(cameraRangeForBounds(point, DEFAULTS)).toEqual(DEFAULTS);
    });

    it("leaves a small scene on the defaults -- they are floors, not targets", () => {
        // 10 x 10 m: 3 * diagonal is ~42 m, far below the 500 m floor.
        const small = { minX: -5, maxX: 5, minY: -5, maxY: 5 };
        expect(cameraRangeForBounds(small, DEFAULTS)).toEqual(DEFAULTS);
    });

    it("widens both range limits for a scene larger than the defaults cover", () => {
        // 640 x 80 m, i.e. the shape of a few-hundred-metre drive.
        const big = { minX: -20, maxX: 620, minY: -40, maxY: 40 };
        const diagonal = Math.hypot(640, 80);
        const { far, maxDistance } = cameraRangeForBounds(big, DEFAULTS);

        expect(far).toBeCloseTo(diagonal * 3, 6);
        expect(maxDistance).toBeCloseTo(diagonal * 1.5, 6);
        // The camera must be able to reach a viewpoint that still sees the
        // whole scene: everything within the orbit limit stays inside far.
        expect(far).toBeGreaterThan(maxDistance + diagonal);
    });

    it("defaults missing config entries to zero instead of NaN", () => {
        expect(cameraRangeForBounds(null, {})).toEqual({ far: 0, maxDistance: 0 });
        expect(cameraRangeForBounds(null)).toEqual({ far: 0, maxDistance: 0 });
    });
});
