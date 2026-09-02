import { expect, test } from "@playwright/test";

// Scalar-chart painting tripwire. The Analysis panel's uPlot chart shipped
// blank for a long time and no test caught it: the panel opened, the tab and
// the Export CSV button rendered, and the canvas underneath stayed empty. The
// failure modes were all invisible to a DOM-level assertion --
//   * the x scale was never pinned, so it stayed null and every point mapped
//     to NaN (uPlot scale `min`/`max` are outputs; `range` is the pin),
//   * the render loop redrew without rebuilding paths, so the chart kept
//     drawing whatever data it first saw,
//   * the y axis offered a single tick increment that didn't fit the panel's
//     height, so uPlot drew no ticks at all,
// -- which is why this asserts on painted pixels rather than on elements
// existing. Runs against the default demo scene (5599), whose "energy" scalar
// differs between its two batches.

async function chartState(page) {
    return page.evaluate(() => {
        const app = window.__debugSimView;
        const chart = app.scalarPlotter.charts.get(app.scalarPlotter.activeScalar);
        if (!chart) return null;

        // Count non-transparent pixels and how far they spread horizontally:
        // a stale-path or collapsed-scale chart still paints a few pixels in a
        // sliver at the left edge, so coverage matters, not just "something".
        const canvas = chart.ctx.canvas;
        const pixels = chart.ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let painted = 0;
        let minX = Infinity;
        let maxX = -1;
        for (let y = 0; y < canvas.height; y++) {
            for (let x = 0; x < canvas.width; x++) {
                if (pixels[(y * canvas.width + x) * 4 + 3] > 0) {
                    painted++;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                }
            }
        }
        return {
            painted,
            spanX: maxX - minX,
            canvasWidth: canvas.width,
            xMin: chart.scales.x.min,
            xMax: chart.scales.x.max,
            yTicksFound: chart.axes[1]._found ? chart.axes[1]._found[0] : 0,
        };
    });
}

test("the scalar chart actually paints its data and y-axis ticks", async ({ page }) => {
    const errors = [];
    page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto("/");
    await page.waitForSelector("#loading-splash", { state: "detached", timeout: 20_000 });

    // The Analysis panel starts collapsed; the charts only update while it is open.
    await page.getByText("Analysis", { exact: false }).first().click();
    await page.getByRole("button", { name: "Play" }).click();
    await page.waitForTimeout(2000);

    const state = await chartState(page);
    expect(state).not.toBeNull();

    // A pinned x scale: null/NaN bounds are the original blank-chart failure.
    expect(Number.isFinite(state.xMin)).toBe(true);
    expect(Number.isFinite(state.xMax)).toBe(true);
    expect(state.xMax).toBeGreaterThan(state.xMin);

    // Real content, spread across a decent part of the canvas rather than
    // bunched into a sliver by paths built for the first frame's data.
    expect(state.painted).toBeGreaterThan(300);
    expect(state.spanX).toBeGreaterThan(state.canvasWidth / 3);

    // At least one y tick increment fit the axis.
    expect(state.yTicksFound).toBeGreaterThan(0);

    expect(errors).toEqual([]);
});
