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

// Cross-language agreement with simview/diff.py's parent-chain resolution.
// `simview diff` compares world poses through its own stdlib port of this
// composition (there is no shared implementation -- see diff.py's module
// docstring), so the exact same scene must resolve to the exact same numbers
// on both sides. The Python half of this pair is
// tests/test_diff.py::test_parented_body_is_diffed_in_world_space.
describe("resolveStateBodies matches simview/diff.py", () => {
    const HALF_SQRT2 = Math.SQRT1_2;

    it("resolves the shared articulated fixture to the same world poses", () => {
        const meta = buildBodyMeta([
            { name: "Chassis" },
            { name: "Arm", parent: "Chassis" },
        ]);
        const order = topoSortBodies(meta);
        const rawBodies = [
            {
                name: "Chassis",
                bodyTransform: [
                    // batch 0: identity; batch 1: 90 deg yaw about +Z.
                    [0, 0, 0, 1, 0, 0, 0],
                    [0, 0, 0, HALF_SQRT2, 0, 0, HALF_SQRT2],
                ],
            },
            {
                // Same local pose in both batches: 2m along the parent's +X.
                name: "Arm",
                bodyTransform: [
                    [2, 0, 0, 1, 0, 0, 0],
                    [2, 0, 0, 1, 0, 0, 0],
                ],
            },
        ];

        const rows = resolveStateBodies(meta, order, 2, rawBodies).get("Arm")
            .bodyTransform;

        // Batch 0 -> (2, 0, 0); batch 1's yaw swings it to (0, 2, 0).
        expect(rows[0][0]).toBeCloseTo(2, 6);
        expect(rows[0][1]).toBeCloseTo(0, 6);
        expect(rows[1][0]).toBeCloseTo(0, 6);
        expect(rows[1][1]).toBeCloseTo(2, 6);

        // Separation of 2*sqrt(2), the position_error the Python test asserts.
        const dx = rows[0][0] - rows[1][0];
        const dy = rows[0][1] - rows[1][1];
        const dz = rows[0][2] - rows[1][2];
        expect(Math.hypot(dx, dy, dz)).toBeCloseTo(2 * Math.SQRT2, 6);

        // ...and 90 deg of orientation error, matching the Python assertion.
        const qa = new THREE.Quaternion(rows[0][4], rows[0][5], rows[0][6], rows[0][3]);
        const qb = new THREE.Quaternion(rows[1][4], rows[1][5], rows[1][6], rows[1][3]);
        const angleDeg = THREE.MathUtils.radToDeg(qa.angleTo(qb));
        expect(angleDeg).toBeCloseTo(90, 6);
    });

    it("resolves a rigid (constant localTransform) child the same way", () => {
        const meta = buildBodyMeta([
            { name: "Chassis" },
            { name: "Sensor", parent: "Chassis", localTransform: [2, 0, 0, 1, 0, 0, 0] },
        ]);
        const order = topoSortBodies(meta);
        const rawBodies = [
            {
                name: "Chassis",
                bodyTransform: [
                    [0, 0, 0, 1, 0, 0, 0],
                    [0, 0, 0, HALF_SQRT2, 0, 0, HALF_SQRT2],
                ],
            },
        ];

        const rows = resolveStateBodies(meta, order, 2, rawBodies).get("Sensor")
            .bodyTransform;

        expect(rows[0][0]).toBeCloseTo(2, 6);
        expect(rows[1][1]).toBeCloseTo(2, 6);
        expect(
            Math.hypot(rows[0][0] - rows[1][0], rows[0][1] - rows[1][1])
        ).toBeCloseTo(2 * Math.SQRT2, 6);
    });
});
