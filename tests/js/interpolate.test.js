import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
    interpolateTransformRow,
    interpolateTransformRows,
    lerpVector3Row,
    lerpVectorRows,
} from "../../simview/static/js/utils/interpolate.js";

const IDENTITY = [0, 0, 0, 1, 0, 0, 0];

function transformFor(pos, quat) {
    return [pos[0], pos[1], pos[2], quat.w, quat.x, quat.y, quat.z];
}

describe("interpolateTransformRow", () => {
    it("alpha=0 reproduces the start row exactly", () => {
        const a = transformFor([1, 2, 3], new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4));
        const b = transformFor([4, 5, 6], new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2));
        const result = interpolateTransformRow(a, b, 0);
        for (let i = 0; i < 7; i++) expect(result[i]).toBeCloseTo(a[i], 10);
    });

    it("alpha=1 reproduces the end row exactly", () => {
        const a = transformFor([1, 2, 3], new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4));
        const b = transformFor([4, 5, 6], new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2));
        const result = interpolateTransformRow(a, b, 1);
        for (let i = 0; i < 7; i++) expect(result[i]).toBeCloseTo(b[i], 10);
    });

    it("interpolates position linearly", () => {
        const a = transformFor([0, 0, 0], new THREE.Quaternion());
        const b = transformFor([10, 20, 30], new THREE.Quaternion());
        const result = interpolateTransformRow(a, b, 0.25);
        expect(result[0]).toBeCloseTo(2.5, 10);
        expect(result[1]).toBeCloseTo(5, 10);
        expect(result[2]).toBeCloseTo(7.5, 10);
    });

    it("midpoint of a 90 degree rotation about Z is a 45 degree rotation", () => {
        const axis = new THREE.Vector3(0, 0, 1);
        const a = transformFor([0, 0, 0], new THREE.Quaternion().setFromAxisAngle(axis, 0));
        const b = transformFor([0, 0, 0], new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 2));
        const result = interpolateTransformRow(a, b, 0.5);
        const resultQuat = new THREE.Quaternion(result[4], result[5], result[6], result[3]);
        const expectedQuat = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 4);
        expect(Math.abs(resultQuat.dot(expectedQuat))).toBeCloseTo(1, 6);
    });

    it("takes the shortest path across the double cover (q vs -q inputs)", () => {
        const axis = new THREE.Vector3(0, 0, 1);
        const qa = new THREE.Quaternion().setFromAxisAngle(axis, 0.1);
        const qbShort = new THREE.Quaternion().setFromAxisAngle(axis, 0.2);
        // Negated quaternion represents the exact same rotation as qbShort.
        const qbNegated = new THREE.Quaternion(-qbShort.x, -qbShort.y, -qbShort.z, -qbShort.w);

        const a = transformFor([0, 0, 0], qa);
        const bShort = transformFor([0, 0, 0], qbShort);
        const bNegated = transformFor([0, 0, 0], qbNegated);

        const resultShort = interpolateTransformRow(a, bShort, 0.5);
        const resultNegated = interpolateTransformRow(a, bNegated, 0.5);

        // Both paths should produce (up to sign) the same interpolated rotation --
        // the naive (non-shortest-path) slerp toward -q would instead produce the
        // rotation's antipode-through-the-long-way, which differs here.
        const qShort = new THREE.Quaternion(resultShort[4], resultShort[5], resultShort[6], resultShort[3]);
        const qNeg = new THREE.Quaternion(resultNegated[4], resultNegated[5], resultNegated[6], resultNegated[3]);
        expect(Math.abs(qShort.dot(qNeg))).toBeCloseTo(1, 6);

        // And that shared result must equal simple slerp toward the near copy,
        // i.e. angle 0.15 about Z -- not 0.1 - (2*pi - 0.1)/2 or similar wrap-around.
        const expected = new THREE.Quaternion().setFromAxisAngle(axis, 0.15);
        expect(Math.abs(qShort.dot(expected))).toBeCloseTo(1, 6);
    });

    it("preserves quaternion normalization", () => {
        const a = transformFor([0, 0, 0], new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3));
        const b = transformFor([0, 0, 0], new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.2));
        const result = interpolateTransformRow(a, b, 0.37);
        const q = new THREE.Quaternion(result[4], result[5], result[6], result[3]);
        expect(q.length()).toBeCloseTo(1, 6);
    });
});

describe("interpolateTransformRows", () => {
    it("handles multiple batches independently", () => {
        const a = [
            transformFor([0, 0, 0], new THREE.Quaternion()),
            transformFor([100, 0, 0], new THREE.Quaternion()),
        ];
        const b = [
            transformFor([10, 0, 0], new THREE.Quaternion()),
            transformFor([200, 0, 0], new THREE.Quaternion()),
        ];
        const result = interpolateTransformRows(a, b, 0.5);
        expect(result).toHaveLength(2);
        expect(result[0][0]).toBeCloseTo(5, 10);
        expect(result[1][0]).toBeCloseTo(150, 10);
    });

    it("alpha=0/1 reproduce endpoints exactly across batches", () => {
        const a = [transformFor([1, 1, 1], new THREE.Quaternion()), transformFor([2, 2, 2], new THREE.Quaternion())];
        const b = [transformFor([9, 9, 9], new THREE.Quaternion()), transformFor([8, 8, 8], new THREE.Quaternion())];
        const at0 = interpolateTransformRows(a, b, 0);
        const at1 = interpolateTransformRows(a, b, 1);
        for (let i = 0; i < 2; i++) {
            for (let c = 0; c < 7; c++) {
                expect(at0[i][c]).toBeCloseTo(a[i][c], 10);
                expect(at1[i][c]).toBeCloseTo(b[i][c], 10);
            }
        }
    });

    it("passes through extra rows from the longer array unchanged", () => {
        const a = [transformFor([0, 0, 0], new THREE.Quaternion())];
        const b = [transformFor([10, 0, 0], new THREE.Quaternion()), transformFor([99, 99, 99], new THREE.Quaternion())];
        const result = interpolateTransformRows(a, b, 0.5);
        expect(result).toHaveLength(1);
        expect(result[0][0]).toBeCloseTo(5, 10);
    });
});

describe("lerpVector3Row", () => {
    it("interpolates a plain 3-vector linearly", () => {
        expect(lerpVector3Row([0, 0, 0], [10, 20, 30], 0.5)).toEqual([5, 10, 15]);
    });

    it("alpha=0/1 reproduce endpoints exactly", () => {
        const a = [1, 2, 3];
        const b = [7, 8, 9];
        expect(lerpVector3Row(a, b, 0)).toEqual(a);
        expect(lerpVector3Row(a, b, 1)).toEqual(b);
    });
});

describe("lerpVectorRows", () => {
    it("handles multiple batches independently", () => {
        const a = [[0, 0, 0], [1, 1, 1]];
        const b = [[10, 10, 10], [3, 3, 3]];
        const result = lerpVectorRows(a, b, 0.5);
        expect(result).toEqual([[5, 5, 5], [2, 2, 2]]);
    });

    it("returns the defined side when the other is missing", () => {
        expect(lerpVectorRows(null, [[1, 2, 3]], 0.5)).toEqual([[1, 2, 3]]);
        expect(lerpVectorRows([[1, 2, 3]], undefined, 0.5)).toEqual([[1, 2, 3]]);
    });
});
