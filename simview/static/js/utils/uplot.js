import uPlot from "../../lib/uPlot.esm.js";

// Shared skeleton for the three Analysis-panel charts (ScalarPlotter,
// ErrorMetrics, TerrainProfile): sized to the plot div, a hidden legend, drag
// disabled, and "click seeks playback to that time" wiring -- the one piece
// duplicated verbatim across all three. Callers pass only what differs:
// series/scales/axes/hooks/padding. `onClick`, if given, runs first on every
// click (with the chart, the clicked data index, and the raw event) for a
// panel that needs more than a seek -- e.g. ScalarPlotter also focuses the
// batch whose series is closest to the click.
export function makeChart(
    plotDiv,
    { series, scales, axes, hooks, padding = [8, 8, 0, 8], onClick },
    data,
    app
) {
    const rect = plotDiv.getBoundingClientRect();
    const chart = new uPlot(
        {
            width: Math.max(rect.width, 1),
            height: Math.max(rect.height, 1),
            padding,
            series,
            scales,
            axes,
            legend: { show: false },
            cursor: {
                drag: { x: false, y: false },
                points: { show: false },
            },
            hooks,
        },
        data,
        plotDiv
    );

    chart.over.addEventListener("click", (e) => {
        const idx = chart.cursor.idx;
        if (idx === null || idx === undefined) return;
        if (onClick) onClick(chart, idx, e);
        const xVal = chart.data[0][idx];
        if (xVal !== undefined && xVal !== null && app.animationController) {
            app.animationController.goToTime(xVal);
        }
    });

    return chart;
}
