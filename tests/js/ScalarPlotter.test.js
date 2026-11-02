import { describe, expect, it, vi } from "vitest";
import { normalizeEpisodes } from "../../simview/static/js/utils/episodes.js";

// config.js reads window.devicePixelRatio at module load time (same stub the
// other suites use); uPlot needs a real DOM at load, and no chart is built here.
globalThis.window ??= { devicePixelRatio: 1 };
vi.mock("../../simview/static/js/utils/uplot.js", () => ({ makeChart() {}, yIncrements: [] }));
const { ScalarPlotter } = await import("../../simview/static/js/ui/ScalarPlotter.js");

describe("ScalarPlotter tooltip", () => {
    it("describes the episode of the hovered batch, not the focused one", () => {
        // Two batches, one episode; batch 1 is hovered (closest to y=10).
        const series = [
            [1, 1, 1],
            [10, 10, 10],
        ];
        const plotter = Object.create(ScalarPlotter.prototype);
        Object.assign(plotter, {
            currentFocusedBatch: 0,
            episodes: normalizeEpisodes([{ startIndex: 0 }], 3),
            times: [0, 1, 2],
            scalarSeries: new Map([["reward", series]]),
            episodeAggregateCache: new Map(),
            app: {
                batchManager: {
                    getColorForBatch: () => "#fff",
                    getBatchName: (i) => `b${i}`,
                },
            },
        });
        const u = {
            data: [[0, 1, 2], ...series],
            cursor: { top: 0 },
            posToVal: () => 10,
        };
        const html = plotter._tooltipHtml(u, 1, "reward");
        expect(html).toContain("Batch: b1");
        expect(html).toContain("sum 30.000, mean 10.000");
    });
});
