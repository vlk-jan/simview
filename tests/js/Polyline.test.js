import { describe, expect, it } from "vitest";

globalThis.window ??= { devicePixelRatio: 1 };
const { Polyline } = await import("../../simview/static/js/objects/Polyline.js");

function fakeApp(simBatches = 1, hidden = new Set()) {
    return {
        batchManager: {
            simBatches,
            getBatchOffset: (i) => ({ x: 10 * i, y: 0, z: 0 }),
            isBatchVisible: (i) => !hidden.has(i),
        },
        uiState: { polylinesVisible: true },
        scene: null,
    };
}

describe("Polyline", () => {
    it("builds a static line per batch at the batch offset", () => {
        const p = new Polyline(
            { name: "route", points: new Float32Array([0, 0, 0, 1, 0, 0, 2, 1, 0]), color: [1, 0, 0] },
            fakeApp(2, new Set([1]))
        );
        expect(p.lines).toHaveLength(2);
        expect(p.lines[1].position.x).toBe(10);
        expect(p.lines[0].geometry.attributes.position.count).toBe(3);
        expect(p.lines[0].geometry).toBe(p.lines[1].geometry);
        expect(p.lines[0].frustumCulled).toBe(false);
        expect(p.lines[1].visible).toBe(false); // hidden batch
        p.update(0); // no-op for the static form
        expect(p.lines[0].geometry.drawRange.count).toBe(Infinity);
    });

    it("draws each frame up to its first NaN row", () => {
        // T=2, B=1, maxVertices=3
        const frames = new Float32Array([
            0, 0, 0, 1, 0, 0, NaN, NaN, NaN, // frame 0: 2 vertices
            5, 5, 5, 6, 5, 5, 7, 5, 5, // frame 1: 3 vertices
        ]);
        const p = new Polyline({ name: "plan", frames, maxVertices: 3, dashed: true }, fakeApp());
        p.update(0);
        expect(p.lines[0].geometry.drawRange.count).toBe(2);
        // The NaN padding never reaches the GPU buffer (bounding sphere stays finite).
        expect(Array.from(p.lines[0].geometry.attributes.position.array)).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0]);
        p.update(1);
        expect(p.lines[0].geometry.drawRange.count).toBe(3);
        expect(Array.from(p.lines[0].geometry.attributes.position.array.subarray(0, 3))).toEqual([5, 5, 5]);
        expect(p.lines[0].geometry.attributes.lineDistance).toBeDefined();
        expect(p.material.isLineDashedMaterial).toBe(true);
    });

    it("ANDs the UI toggle with time-ranged visibility", () => {
        const p = new Polyline({ name: "r", points: [[0, 0, 0], [1, 1, 1]], visibleRanges: [[0, 1]] }, fakeApp());
        p.setTimeVisible(false);
        expect(p.group.visible).toBe(false);
        p.setTimeVisible(true);
        expect(p.group.visible).toBe(true);
        p.setVisible(false);
        p.setTimeVisible(true);
        expect(p.group.visible).toBe(false);
    });
});
