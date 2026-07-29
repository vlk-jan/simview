import { describe, expect, it } from "vitest";
import {
    bilinearSample,
    buildTerrainSeries,
} from "../../simview/static/js/utils/terrainSample.js";

// 3x3 grid, row-major (row = y, col = x):
//  row0 (y=0): 0  1  2
//  row1 (y=1): 3  4  5
//  row2 (y=2): 6  7  8
const grid3x3 = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const dims3x3 = { resolutionX: 3, resolutionY: 3 };
const bounds3x3 = { minX: 0, maxX: 2, minY: 0, maxY: 2 };

describe("bilinearSample", () => {
    it("returns the exact value at grid points", () => {
        expect(bilinearSample(grid3x3, dims3x3, bounds3x3, 0, 0)).toBeCloseTo(0);
        expect(bilinearSample(grid3x3, dims3x3, bounds3x3, 2, 0)).toBeCloseTo(2);
        expect(bilinearSample(grid3x3, dims3x3, bounds3x3, 0, 2)).toBeCloseTo(6);
        expect(bilinearSample(grid3x3, dims3x3, bounds3x3, 2, 2)).toBeCloseTo(8);
        expect(bilinearSample(grid3x3, dims3x3, bounds3x3, 1, 1)).toBeCloseTo(4);
    });

    it("interpolates linearly at an interior point", () => {
        // Halfway between (0,0)=0 and (1,0)=1 along x, at y=0.
        expect(bilinearSample(grid3x3, dims3x3, bounds3x3, 0.5, 0)).toBeCloseTo(0.5);
        // Halfway between (0,0)=0 and (0,1)=3 along y, at x=0.
        expect(bilinearSample(grid3x3, dims3x3, bounds3x3, 0, 0.5)).toBeCloseTo(1.5);
        // Quarter point in both x and y within the (0,0)-(1,1) cell:
        // values 0, 1, 3, 4 bilinearly weighted.
        expect(bilinearSample(grid3x3, dims3x3, bounds3x3, 0.25, 0.25)).toBeCloseTo(
            0 * 0.75 * 0.75 + 1 * 0.25 * 0.75 + 3 * 0.75 * 0.25 + 4 * 0.25 * 0.25
        );
    });

    it("clamps out-of-extent points to the nearest edge", () => {
        expect(bilinearSample(grid3x3, dims3x3, bounds3x3, -5, -5)).toBeCloseTo(0);
        expect(bilinearSample(grid3x3, dims3x3, bounds3x3, 50, 50)).toBeCloseTo(8);
        // Off to the left but within y-range: clamps x to 0, keeps y.
        expect(bilinearSample(grid3x3, dims3x3, bounds3x3, -5, 1)).toBeCloseTo(3);
        // Off the top but within x-range: clamps y to max, keeps x.
        expect(bilinearSample(grid3x3, dims3x3, bounds3x3, 1, 50)).toBeCloseTo(7);
    });

    it("falls back to 0 when the bounds are degenerate on an axis", () => {
        const degenerateBounds = { minX: 5, maxX: 5, minY: 0, maxY: 2 };
        // fx collapses to 0 regardless of x, so the sample only varies with y.
        expect(
            bilinearSample(grid3x3, dims3x3, degenerateBounds, 123, 0)
        ).toBeCloseTo(0);
        expect(
            bilinearSample(grid3x3, dims3x3, degenerateBounds, -999, 2)
        ).toBeCloseTo(6);
    });
});

describe("buildTerrainSeries", () => {
    const times = [0, 1, 2];
    // Two batches, each walking straight along y=0 from x=0 to x=2.
    const paths = [
        [
            [0, 0],
            [1, 0],
            [2, 0],
        ],
        [
            [0, 2],
            [1, 2],
            [2, 2],
        ],
    ];

    it("samples each batch's own path against its own terrain by default", () => {
        const gridB1 = grid3x3.map((v) => v + 100); // batch 1's terrain is offset
        const series = buildTerrainSeries({
            times,
            paths,
            grids: [grid3x3, gridB1],
            dimensions: dims3x3,
            bounds: bounds3x3,
            isSingleton: false,
            referenceBatch: null,
        });

        expect(series).toHaveLength(2);
        // Batch 0 walks along row y=0 of its own (unshifted) grid: 0, 1, 2.
        expect(series[0].map((p) => p.y)).toEqual([0, 1, 2]);
        // Batch 1 walks along row y=2 of its own (+100) grid: 106, 107, 108.
        expect(series[1].map((p) => p.y)).toEqual([106, 107, 108]);
        expect(series[0].map((p) => p.x)).toEqual(times);
    });

    it("supports a shared singleton grid for every batch", () => {
        const series = buildTerrainSeries({
            times,
            paths,
            grids: [grid3x3],
            dimensions: dims3x3,
            bounds: bounds3x3,
            isSingleton: true,
            referenceBatch: null,
        });

        expect(series[0].map((p) => p.y)).toEqual([0, 1, 2]);
        // Batch 1 samples the same singleton grid, but along row y=2.
        expect(series[1].map((p) => p.y)).toEqual([6, 7, 8]);
    });

    it("samples every batch along a chosen reference batch's path", () => {
        const gridB1 = grid3x3.map((v) => v + 100);
        const series = buildTerrainSeries({
            times,
            paths,
            grids: [grid3x3, gridB1],
            dimensions: dims3x3,
            bounds: bounds3x3,
            isSingleton: false,
            referenceBatch: 0, // sample both terrains along batch 0's (y=0) path
        });

        // Both series now walk row y=0 of their respective terrain.
        expect(series[0].map((p) => p.y)).toEqual([0, 1, 2]);
        expect(series[1].map((p) => p.y)).toEqual([100, 101, 102]);
    });

    it("skips frames with missing or non-finite body data", () => {
        const pathsWithGaps = [
            [
                [0, 0],
                null,
                [2, 0],
            ],
            [[0, 2], undefined, [NaN, 2]],
        ];
        const series = buildTerrainSeries({
            times,
            paths: pathsWithGaps,
            grids: [grid3x3],
            dimensions: dims3x3,
            bounds: bounds3x3,
            isSingleton: true,
            referenceBatch: null,
        });

        expect(series[0]).toEqual([
            { x: 0, y: 0 },
            { x: 2, y: 2 },
        ]);
        expect(series[1]).toEqual([{ x: 0, y: 6 }]);
    });

    it("returns an empty series for a batch with no path or grid data", () => {
        const series = buildTerrainSeries({
            times,
            paths: [paths[0], null],
            grids: [grid3x3],
            dimensions: dims3x3,
            bounds: bounds3x3,
            isSingleton: true,
            referenceBatch: null,
        });

        expect(series[0].length).toBe(3);
        expect(series[1]).toEqual([]);
    });
});
