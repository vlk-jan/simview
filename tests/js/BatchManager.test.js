import * as THREE from "three";
import { describe, expect, it } from "vitest";

// config.js reads window.devicePixelRatio at module load time (same stub the
// other suites use). BatchManager itself needs no DOM beyond that.
globalThis.window ??= { devicePixelRatio: 1 };
const { BatchManager } = await import(
    "../../simview/static/js/components/BatchManager.js"
);

// Records what setActiveBatch forwards to the panels, so an out-of-range index
// leaking through is visible.
function fakeApp() {
    return {
        bodyStateWindow: {
            selectedBatch: null,
            setSelectedBatch(i) {
                this.selectedBatch = i;
            },
        },
        scalarPlotter: {
            focusedBatch: null,
            setFocusedBatch(i) {
                this.focusedBatch = i;
            },
        },
        batchLegend: {
            highlightCalls: 0,
            highlightActive() {
                this.highlightCalls++;
            },
        },
        camera: null,
        scene: { camera: null },
    };
}

function makeBatchManager(simBatches) {
    const app = fakeApp();
    const manager = new BatchManager(app, {
        simBatches,
        terrain: { dimensions: { sizeX: 10, sizeY: 10 } },
    });
    // changeFocusOnBatchByIndex moves the real camera; stub it out so these
    // tests stay about the index guard, not THREE camera math.
    manager.changeFocusOnBatchByIndex = () => {};
    return { app, manager };
}

describe("BatchManager.setActiveBatch", () => {
    it("focuses a valid batch and forwards it to the panels", () => {
        const { app, manager } = makeBatchManager(4);

        manager.setActiveBatch(2);

        expect(manager.currentlyActiveBatch).toBe(2);
        expect(app.bodyStateWindow.selectedBatch).toBe(2);
        expect(app.scalarPlotter.focusedBatch).toBe(2);
        expect(app.batchLegend.highlightCalls).toBe(1);
    });

    it("does not forward an out-of-range index to the panels", () => {
        const { app, manager } = makeBatchManager(4);
        manager.setActiveBatch(1);
        app.batchLegend.highlightCalls = 0;

        manager.setActiveBatch(9);

        // Everything stays on the last valid batch rather than following an
        // index setActiveBatch itself rejected.
        expect(manager.currentlyActiveBatch).toBe(1);
        expect(app.bodyStateWindow.selectedBatch).toBe(1);
        expect(app.scalarPlotter.focusedBatch).toBe(1);
        expect(app.batchLegend.highlightCalls).toBe(0);
    });

    it("rejects a negative index too", () => {
        const { app, manager } = makeBatchManager(4);
        manager.setActiveBatch(3);

        manager.setActiveBatch(-1);

        expect(manager.currentlyActiveBatch).toBe(3);
        expect(app.bodyStateWindow.selectedBatch).toBe(3);
    });
});

describe("BatchManager.changeFocusOnBatchByIndex", () => {
    function withCamera(simBatches) {
        const { app, manager } = makeBatchManager(simBatches);
        delete manager.changeFocusOnBatchByIndex; // back to the real method
        let updates = 0;
        app.scene = {
            camera: { position: new THREE.Vector3(3, -4, 10) },
            controls: { target: new THREE.Vector3(3, 1, 0), update: () => updates++ },
        };
        return { app, manager, updates: () => updates };
    }

    it("leaves the view alone when the batch does not change", () => {
        const { app, manager, updates } = withCamera(4);
        manager.setActiveBatch(0);

        expect(app.scene.controls.target.toArray()).toEqual([3, 1, 0]);
        expect(app.scene.camera.position.toArray()).toEqual([3, -4, 10]);
        expect(updates()).toBe(0);
    });

    it("moves camera and target by the offset between the two cells", () => {
        const { app, manager } = withCamera(4);
        const from = manager.getBatchOffset(0);
        const to = manager.getBatchOffset(3);
        manager.setActiveBatch(3);

        const shift = [to.x - from.x, to.y - from.y, to.z - from.z];
        expect(shift.some((v) => v !== 0)).toBe(true);
        expect(app.scene.controls.target.toArray()).toEqual([3 + shift[0], 1 + shift[1], shift[2]]);
        expect(app.scene.camera.position.toArray()).toEqual([3 + shift[0], -4 + shift[1], 10 + shift[2]]);
    });
});

describe("BatchManager.refreshVisibleBatches", () => {
    it("pins the split-screen batches in focused render mode", () => {
        const { app, manager } = makeBatchManager(40); // > 32 -> focused by default
        app.uiState = { splitScreen: true, splitBatchA: 0, splitBatchB: 5 };
        expect(manager.isBatchVisible(5)).toBe(false);

        manager.refreshVisibleBatches();

        expect(manager.isBatchVisible(5)).toBe(true);
        app.uiState.splitBatchB = 7;
        manager.refreshVisibleBatches();
        expect(manager.isBatchVisible(7)).toBe(true);
        expect(manager.isBatchVisible(5)).toBe(false);
    });
});

describe("BatchManager._persistBatchNames", () => {
    const realFetch = globalThis.fetch;
    function withFetch(response) {
        globalThis.fetch = async () => response;
    }

    it("tells the legend once when the server cannot persist renames", async () => {
        const { app, manager } = makeBatchManager(2);
        const notices = [];
        app.batchLegend.showNotice = (t) => notices.push(t);
        withFetch({ ok: true, json: async () => ({ ok: true, persisted: false }) });
        try {
            await manager._persistBatchNames();
            await manager._persistBatchNames();
        } finally {
            globalThis.fetch = realFetch;
        }
        expect(notices).toHaveLength(1);
    });

    it("tells the legend when the request fails", async () => {
        const { app, manager } = makeBatchManager(2);
        const notices = [];
        app.batchLegend.showNotice = (t) => notices.push(t);
        withFetch({ ok: false, status: 500 });
        try {
            await manager._persistBatchNames();
            globalThis.fetch = async () => {
                throw new Error("offline");
            };
            await manager._persistBatchNames();
        } finally {
            globalThis.fetch = realFetch;
        }
        expect(notices).toHaveLength(2);
    });
});
