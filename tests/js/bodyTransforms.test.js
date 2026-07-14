import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
    buildBodyMeta,
    resolveStateBodies,
    topoSortBodies,
} from "../../simview/static/js/utils/bodyTransforms.js";

// Wire order is [x, y, z, w, qx, qy, qz].
const IDENTITY = [0, 0, 0, 1, 0, 0, 0];

function transformFor(pos, quat) {
    return [pos[0], pos[1], pos[2], quat.w, quat.x, quat.y, quat.z];
}

describe("buildBodyMeta", () => {
    it("defaults parent/localTransform to null for plain absolute bodies", () => {
        const meta = buildBodyMeta([{ name: "a" }, { name: "b", parent: null }]);
        expect(meta.get("a")).toEqual({ parent: null, localTransform: null });
        expect(meta.get("b")).toEqual({ parent: null, localTransform: null });
    });

    it("captures parent and localTransform for attached bodies", () => {
        const local = [1, 2, 3, 1, 0, 0, 0];
        const meta = buildBodyMeta([{ name: "child", parent: "root", localTransform: local }]);
        expect(meta.get("child")).toEqual({ parent: "root", localTransform: local });
    });
});

describe("topoSortBodies", () => {
    it("orders parents before children regardless of declaration order", () => {
        const meta = buildBodyMeta([
            { name: "grandchild", parent: "child" },
            { name: "child", parent: "root" },
            { name: "root" },
        ]);
        const order = topoSortBodies(meta);
        expect(order.indexOf("root")).toBeLessThan(order.indexOf("child"));
        expect(order.indexOf("child")).toBeLessThan(order.indexOf("grandchild"));
        expect(order).toHaveLength(3);
    });

    it("throws on a self-referencing parent", () => {
        const meta = buildBodyMeta([{ name: "a", parent: "a" }]);
        expect(() => topoSortBodies(meta)).toThrow(/cannot be its own parent/);
    });

    it("throws on an unknown parent", () => {
        const meta = buildBodyMeta([{ name: "a", parent: "ghost" }]);
        expect(() => topoSortBodies(meta)).toThrow(/unknown parent/);
    });

    it("throws on a cyclic parent chain", () => {
        const meta = buildBodyMeta([
            { name: "a", parent: "b" },
            { name: "b", parent: "a" },
        ]);
        expect(() => topoSortBodies(meta)).toThrow(/Cycle detected/);
    });
});

describe("resolveStateBodies", () => {
    it("passes plain absolute bodies through unchanged", () => {
        const meta = buildBodyMeta([{ name: "root" }]);
        const order = topoSortBodies(meta);
        const rawBodies = [{ name: "root", bodyTransform: IDENTITY, velocity: [1, 0, 0] }];
        const resolved = resolveStateBodies(meta, order, 1, rawBodies);
        expect(resolved.get("root")).toEqual(rawBodies[0]);
    });

    it("expands a grouped name entry to every member", () => {
        const meta = buildBodyMeta([{ name: "a" }, { name: "b" }]);
        const order = topoSortBodies(meta);
        const rawBodies = [{ name: ["a", "b"], bodyTransform: IDENTITY }];
        const resolved = resolveStateBodies(meta, order, 1, rawBodies);
        expect(resolved.get("a")).toBe(rawBodies[0]);
        expect(resolved.get("b")).toBe(rawBodies[0]);
    });

    it("derives a rigidly-attached child's world pose from parent pose composed with the local offset", () => {
        const localOffset = [1, 0, 0, 1, 0, 0, 0]; // +1 along parent-local x, no rotation
        const meta = buildBodyMeta([
            { name: "root" },
            { name: "child", parent: "root", localTransform: localOffset },
        ]);
        const order = topoSortBodies(meta);

        // Root rotated 90 degrees about Z, translated to (5, 0, 0).
        const rootQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
        const rootTransform = transformFor([5, 0, 0], rootQuat);
        const rawBodies = [{ name: "root", bodyTransform: rootTransform }];

        const resolved = resolveStateBodies(meta, order, 1, rawBodies);
        const childRow = resolved.get("child").bodyTransform[0];

        // Local +X offset, rotated 90 deg about Z, becomes +Y; then add root position.
        expect(childRow[0]).toBeCloseTo(5, 5); // x
        expect(childRow[1]).toBeCloseTo(1, 5); // y
        expect(childRow[2]).toBeCloseTo(0, 5); // z
        // World quat = rootQuat * localQuat(identity) = rootQuat.
        expect(childRow[3]).toBeCloseTo(rootQuat.w, 5);
        expect(childRow[4]).toBeCloseTo(rootQuat.x, 5);
        expect(childRow[5]).toBeCloseTo(rootQuat.y, 5);
        expect(childRow[6]).toBeCloseTo(rootQuat.z, 5);
    });

    it("composes an articulated (per-frame) child transform with the parent's current-frame pose", () => {
        const meta = buildBodyMeta([{ name: "root" }, { name: "arm", parent: "root" }]);
        const order = topoSortBodies(meta);

        const rootTransform = transformFor([1, 2, 3], new THREE.Quaternion());
        // Per-frame local transform (no static localTransform on the meta entry).
        const localTransform = transformFor([0, 1, 0], new THREE.Quaternion());
        const rawBodies = [
            { name: "root", bodyTransform: rootTransform },
            { name: "arm", bodyTransform: localTransform },
        ];

        const resolved = resolveStateBodies(meta, order, 1, rawBodies);
        const armRow = resolved.get("arm").bodyTransform[0];
        expect(armRow[0]).toBeCloseTo(1, 5);
        expect(armRow[1]).toBeCloseTo(3, 5);
        expect(armRow[2]).toBeCloseTo(3, 5);
    });

    it("orders resolution correctly (parent-before-child) even when topoOrder is supplied that way regardless of input array order", () => {
        const meta = buildBodyMeta([
            { name: "grandchild", parent: "child" },
            { name: "child", parent: "root", localTransform: [0, 0, 1, 1, 0, 0, 0] },
            { name: "root" },
        ]);
        const order = topoSortBodies(meta);
        const rawBodies = [
            { name: "root", bodyTransform: IDENTITY },
            { name: "grandchild", bodyTransform: [0, 0, 1, 1, 0, 0, 0] },
        ];
        const resolved = resolveStateBodies(meta, order, 1, rawBodies);
        // child = root ∘ localTransform(z+1) => z = 1
        expect(resolved.get("child").bodyTransform[0][2]).toBeCloseTo(1, 5);
        // grandchild = child ∘ per-frame local(z+1) => z = 2
        expect(resolved.get("grandchild").bodyTransform[0][2]).toBeCloseTo(2, 5);
    });

    it("leaves a child unresolved when its parent has no pose this frame", () => {
        const meta = buildBodyMeta([{ name: "root" }, { name: "child", parent: "root" }]);
        const order = topoSortBodies(meta);
        const rawBodies = [{ name: "child", bodyTransform: IDENTITY }];
        const resolved = resolveStateBodies(meta, order, 1, rawBodies);
        expect(resolved.has("child")).toBe(false);
    });

    it("handles multi-batch (per-batch row) transforms", () => {
        const meta = buildBodyMeta([{ name: "root" }, { name: "child", parent: "root", localTransform: [0, 1, 0, 1, 0, 0, 0] }]);
        const order = topoSortBodies(meta);
        const rawBodies = [
            {
                name: "root",
                bodyTransform: [
                    [0, 0, 0, 1, 0, 0, 0],
                    [10, 0, 0, 1, 0, 0, 0],
                ],
            },
        ];
        const resolved = resolveStateBodies(meta, order, 2, rawBodies);
        const rows = resolved.get("child").bodyTransform;
        expect(rows).toHaveLength(2);
        expect(rows[0][1]).toBeCloseTo(1, 5);
        expect(rows[1][0]).toBeCloseTo(10, 5);
        expect(rows[1][1]).toBeCloseTo(1, 5);
    });
});
