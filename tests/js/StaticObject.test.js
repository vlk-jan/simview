import { describe, expect, it } from "vitest";
import * as THREE from "three";

globalThis.window ??= { devicePixelRatio: 1 };
const { StaticObject } = await import("../../simview/static/js/objects/StaticObject.js");

describe("StaticObject singleton batch visibility", () => {
    it("collapses hidden batches' instances of a singleton mesh", () => {
        let visible = [true, true];
        const app = {
            batchManager: {
                simBatches: 2,
                getBatchOffset: (i) => ({ x: 10 * i, y: 0, z: 0 }),
                isBatchVisible: (i) => visible[i],
            },
            uiState: { bodyVisualizationMode: "mesh" },
        };
        const obj = new StaticObject(
            { name: "box", isSingleton: true, shape: { type: "box", hx: 1, hy: 1, hz: 1 } },
            app
        );
        const scaleOf = (rep, i) => {
            const m = new THREE.Matrix4();
            rep.getMatrixAt(i, m);
            return new THREE.Vector3().setFromMatrixScale(m).x;
        };

        visible = [true, false];
        obj.refreshBatchVisibility();
        for (const key of ["mesh", "wireframe"]) {
            expect(scaleOf(obj.representations[key], 0)).toBe(1);
            expect(scaleOf(obj.representations[key], 1)).toBe(0);
        }

        visible = [true, true];
        obj.refreshBatchVisibility();
        const m = new THREE.Matrix4();
        obj.representations.mesh.getMatrixAt(1, m);
        expect(new THREE.Vector3().setFromMatrixPosition(m).x).toBe(10);
    });
});
