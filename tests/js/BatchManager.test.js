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
