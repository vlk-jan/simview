import uPlot from "../../lib/uPlot.esm.js";
import { THEME } from "../config.js";

// Shared chart plumbing for the three Analysis-panel charts (ScalarPlotter,
// ErrorMetrics, TerrainProfile); their shared DOM controls live in
// ui/chartControls.js.

// Candidate y-axis tick steps for `incrs`. uPlot walks the list and takes the
// first step whose ticks fit the axis's length (at least `space` px apart).
// Offering exactly one (range/steps) meant that in a short panel -- which is
// what the Analysis panel gives us -- no step fit, and uPlot drew no ticks or
// labels at all. Coarser multiples let it degrade instead of giving up.
export function yIncrements(min, max, steps = 5) {
    const diff = max - min;
    const base = diff === 0 ? Math.max(Math.abs(max) / steps, 1e-3) : diff / steps;
    return [1, 2, 5, 10, 20, 50, 100].map((m) => base * m);
}

// A chart sized to (and kept sized to, via a ResizeObserver) the plot div,
// with a hidden legend, drag disabled, and "click seeks playback to that
// time". Callers pass only what differs: series/scales/axes/hooks/padding.
// - `onClick(chart, idx, e)` runs first on every click, for a panel that
//   needs more than a seek (ScalarPlotter also focuses the closest batch).
// - `tooltip(chart, idx)` returns the hover tooltip's HTML, or null to hide it.
// - `markerTime()` returns the playback time to draw as a vertical line, or null.
// `chart.destroy()` also disconnects the observer and removes the tooltip.
export function makeChart(
    plotDiv,
    { series, scales, axes, hooks = {}, padding = [8, 8, 0, 8], onClick, tooltip, markerTime },
    data,
    app
) {
    const tooltipDiv = document.createElement("div");
    tooltipDiv.className = "sv-chart-tooltip";
    hooks = { ...hooks };
    if (tooltip) {
        hooks.setCursor = [
            ...(hooks.setCursor || []),
            (u) => {
                const idx = u.cursor.idx;
                const html = idx === null || idx === undefined || u.cursor.left < 0 ? null : tooltip(u, idx);
                if (html === null) {
                    tooltipDiv.style.display = "none";
                    return;
                }
                tooltipDiv.innerHTML = html;
                tooltipDiv.style.left = `${u.cursor.left + 12}px`;
                tooltipDiv.style.top = `${u.cursor.top + 12}px`;
                tooltipDiv.style.display = "block";
            },
        ];
    }
    if (markerTime) {
        hooks.draw = [...(hooks.draw || []), (u) => drawMarker(u, markerTime())];
    }

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
    plotDiv.appendChild(tooltipDiv);

    chart.over.addEventListener("click", (e) => {
        const idx = chart.cursor.idx;
        if (idx === null || idx === undefined) return;
        if (onClick) onClick(chart, idx, e);
        const xVal = chart.data[0][idx];
        if (xVal !== undefined && xVal !== null && app.animationController) {
            app.animationController.goToTime(xVal);
        }
    });

    // Hidden (display:none) panels report 0x0 -- keep the last real size.
    const observer = new ResizeObserver(() => {
        const r = plotDiv.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) chart.setSize({ width: r.width, height: r.height });
    });
    observer.observe(plotDiv);
    const destroy = chart.destroy.bind(chart);
    chart.destroy = () => {
        observer.disconnect();
        tooltipDiv.remove();
        destroy();
    };

    return chart;
}

// The current playback time as a vertical line over the finished plot.
function drawMarker(u, time) {
    if (time === null) return;
    const x = u.valToPos(time, "x", true);
    if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) return;
    const ctx = u.ctx;
    ctx.save();
    ctx.strokeStyle = THEME.text;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, u.bbox.top);
    ctx.lineTo(x, u.bbox.top + u.bbox.height);
    ctx.stroke();
    ctx.restore();
}
