import { describe, expect, it } from "vitest";
import {
    maxWithIndex,
    positionAxisError,
    positionError,
    quaternionAngleError,
    rmse,
} from "../../simview/static/js/utils/errorMath.js";

describe("positionError / positionAxisError", () => {
    it("computes per-frame Euclidean error and signed per-axis components", () => {
        const posA = [1, 2, 3];
        const posB = [4, 6, 3];
        const axis = positionAxisError(posA, posB, 0);
        expect(axis).toEqual({ dx: -3, dy: -4, dz: 0 });
        expect(positionError(posA, posB, 0)).toBeCloseTo(5, 10);
    });

    it("indexes into the correct frame for multi-frame flat arrays", () => {
        const posA = [0, 0, 0, /* frame 1 */ 3, 4, 0];
        const posB = [0, 0, 0, /* frame 1 */ 0, 0, 0];
        expect(positionError(posA, posB, 0)).toBeCloseTo(0, 10);
        expect(positionError(posA, posB, 1)).toBeCloseTo(5, 10);
    });
});

describe("quaternionAngleError", () => {
    it("is zero for identical quaternions", () => {
        const q = [1, 0, 0, 0]; // [w, x, y, z] identity
        expect(quaternionAngleError(q, q, 0)).toBeCloseTo(0, 10);
    });

    it("is zero for a quaternion and its negation (double cover)", () => {
        const q = [0.7071067811865476, 0, 0.7071067811865476, 0];
        const negQ = q.map((v) => -v);
        expect(quaternionAngleError(q, negQ, 0)).toBeCloseTo(0, 10);
    });

    it("returns pi/2 for a 90 degree rotation", () => {
        // Identity vs. 90-degree rotation about Z: w = cos(45deg), z = sin(45deg).
        const identity = [1, 0, 0, 0];
        const half = Math.SQRT1_2;
        const rot90 = [half, 0, 0, half];
        expect(quaternionAngleError(identity, rot90, 0)).toBeCloseTo(Math.PI / 2, 6);
    });

    it("indexes into the correct frame for multi-frame flat arrays", () => {
        const identity = [1, 0, 0, 0, /* frame 1 */ 1, 0, 0, 0];
        const half = Math.SQRT1_2;
        const quatB = [1, 0, 0, 0, /* frame 1 */ half, 0, 0, half];
        expect(quaternionAngleError(identity, quatB, 0)).toBeCloseTo(0, 10);
        expect(quaternionAngleError(identity, quatB, 1)).toBeCloseTo(Math.PI / 2, 6);
    });
});

describe("rmse", () => {
    it("computes the root-mean-square of a series", () => {
        expect(rmse([3, 4])).toBeCloseTo(Math.sqrt(12.5), 10);
    });

    it("is zero for all-zero values", () => {
        expect(rmse([0, 0, 0])).toBe(0);
    });

    it("returns 0 for an empty or missing series", () => {
        expect(rmse([])).toBe(0);
        expect(rmse(undefined)).toBe(0);
    });
});

describe("maxWithIndex", () => {
    it("finds the maximum value and its index", () => {
        expect(maxWithIndex([1, 5, 3, 5, 2])).toEqual({ value: 5, index: 1 });
    });

    it("handles a single-element series", () => {
        expect(maxWithIndex([7])).toEqual({ value: 7, index: 0 });
    });

    it("returns value 0 and index -1 for an empty or missing series", () => {
        expect(maxWithIndex([])).toEqual({ value: 0, index: -1 });
        expect(maxWithIndex(undefined)).toEqual({ value: 0, index: -1 });
    });
});
