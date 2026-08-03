import { describe, expect, it } from "vitest";
import { createContactPoints, createPoints } from "../../simview/static/js/objects/utils.js";

// Regression coverage for the bug this session found: blob-decoded point
// data (SimView.js::fetchBlobs) arrives as a flat Float32Array with no
// reshape metadata, but createPoints/createContactPoints used to call
// `.flat()` unconditionally -- which doesn't exist on TypedArrays -- so any
// real (blob-encoded) pointcloud body crashed on load.
describe("createPoints", () => {
    it("accepts a flat Float32Array (post-blob-decode) without throwing", () => {
        const flat = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]);
        const points = createPoints(flat, {});
        expect(points).not.toBeNull();
        const position = points.geometry.getAttribute("position");
        expect(Array.from(position.array)).toEqual(Array.from(flat));
    });

    it("still accepts a plain nested array (non-tensor / hand-authored data)", () => {
        const nested = [
            [0, 0, 0],
            [1, 1, 1],
            [2, 2, 2],
        ];
        const points = createPoints(nested, {});
        expect(points).not.toBeNull();
        const position = points.geometry.getAttribute("position");
        expect(Array.from(position.array)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2]);
    });

    it("returns null for empty/missing input", () => {
        expect(createPoints(null, {})).toBeNull();
        expect(createPoints([], {})).toBeNull();
    });

    it("wires per-point colors into a vertex-colored material when provided", () => {
        const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
        const colors = new Float32Array([1, 0, 0, 0, 1, 0]);
        const points = createPoints(positions, {}, true, colors);
        expect(points.material.vertexColors).toBe(true);
        const colorAttr = points.geometry.getAttribute("color");
        expect(Array.from(colorAttr.array)).toEqual(Array.from(colors));
    });

    it("accepts nested-array colors too", () => {
        const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
        const colors = [
            [1, 0, 0],
            [0, 1, 0],
        ];
        const points = createPoints(positions, {}, true, colors);
        const colorAttr = points.geometry.getAttribute("color");
        expect(Array.from(colorAttr.array)).toEqual([1, 0, 0, 0, 1, 0]);
    });

    it("has no color attribute and vertexColors stays off when colors aren't provided", () => {
        const points = createPoints(new Float32Array([0, 0, 0]), {});
        expect(points.geometry.getAttribute("color")).toBeUndefined();
        expect(points.material.vertexColors).toBe(false);
    });
});

describe("createContactPoints", () => {
    it("accepts a flat Float32Array (post-blob-decode) without throwing", () => {
        const flat = new Float32Array([0, 0, 0, 1, 1, 1]);
        const points = createContactPoints(flat, {});
        expect(points).not.toBeNull();
        const position = points.geometry.getAttribute("position");
        expect(Array.from(position.array)).toEqual(Array.from(flat));
    });

    it("returns null for empty/missing input", () => {
        expect(createContactPoints(null, {})).toBeNull();
        expect(createContactPoints([], {})).toBeNull();
    });
});
