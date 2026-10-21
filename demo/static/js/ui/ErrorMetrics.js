import { FREQ_CONFIG, THEME } from "../config.js";
import { pickDefaultBatchPair } from "../utils/batchPresets.js";
import { downloadCsv, rowsToCsv, sanitizeForFilename } from "../utils/csv.js";
import {
    maxWithIndex,
    positionAxisError,
    positionError,
    quaternionAngleError,
    rmse,
} from "../utils/errorMath.js";
import { makeChart } from "../utils/uplot.js";
import { checkboxGroup, exportBar, selectGroup } from "./chartControls.js";

// One place for the per-series colors: the plot strokes, the hover tooltip and
// the swatches in front of the readout labels all have to agree, otherwise the
// readout stops working as a legend for the curve above it.
const SERIES_COLORS = {
    pos: THEME.blue,
    x: THEME.red,
    y: THEME.green,
    z: THEME.blue,
    rot: THEME.peach,
};

// [label, color, key] for the live readout rows; the color doubles as the
// legend swatch for that curve.
const READOUT_ROWS = [
    ["Position error:", SERIES_COLORS.pos, "pos"],
    ["X error:", SERIES_COLORS.x, "x"],
    ["Y error:", SERIES_COLORS.y, "y"],
    ["Z error:", SERIES_COLORS.z, "z"],
    ["Orientation error:", SERIES_COLORS.rot, "rot"],
];
// A value for display, or "-" for a NaN frame.
const fmt = (v, digits, unit) => (Number.isFinite(v) ? `${v.toFixed(digits)}${unit}` : "-");
// uPlot draws null as a gap; NaN would break the path.
const gapOrValue = (v) => (Number.isFinite(v) ? v : null);

// Same shape, for the summary-stats rows (no curve, so no color).
const STATS_ROWS = [
    ["Position RMSE:", null, "posRmse"],
    ["Max position error (t):", null, "posMax"],
    ["Final drift:", null, "drift"],
    ["Orientation RMSE:", null, "rotRmse"],
    ["Max angle error (t):", null, "rotMax"],
];

// Compares two batches of the same body over the full timeline: Euclidean
// position error and quaternion angle (orientation) error. Useful for e.g.
// comparing a real-world recording batch against a simulated rerun batch.
export class ErrorMetrics {
    constructor(app) {
        this.app = app;
        this.isExpanded = false;
        this.selectedBody = app.bodies.keys().next().value || null;
        const batchNames = Array.from(
            { length: app.batchManager.simBatches },
            (_, i) => app.batchManager.getBatchName(i)
        );
        const defaultPair = pickDefaultBatchPair(batchNames);
        this.batchA = defaultPair.batchA;
        this.batchB = defaultPair.batchB;
        this.showAxes = false;
        this.showStats = false;
        this._clearSeries();
        this.minRenderDelay = 1000 / FREQ_CONFIG.errorMetrics;
        this.lastRenderTime = Number.NEGATIVE_INFINITY;
        this.chart = null;
        this.markerTime = null;

        this._setupHTML();
        this._setupEventListeners();
    }

    _setupHTML() {
        this.content = document.createElement("div");
        this.content.className = "error-metrics-content";

        this.controlsContainer = document.createElement("div");
        this.controlsContainer.className = "error-metrics-controls";
        this.content.appendChild(this.controlsContainer);

        const batchOptions = [...Array(this.app.batchManager.simBatches).keys()].map((i) => ({
            value: i,
            label: `${i}: ${this.app.batchManager.getBatchName(i)}`,
        }));
        const bodyOptions = [...this.app.bodies.keys()].map((n) => ({ value: n, label: n }));
        this.bodySelect = selectGroup(this.controlsContainer, "Body:", bodyOptions, this.selectedBody);
        this.batchASelect = selectGroup(this.controlsContainer, "Batch A:", batchOptions, this.batchA);
        this.batchBSelect = selectGroup(this.controlsContainer, "Batch B:", batchOptions, this.batchB);
        this.axesToggle = checkboxGroup(this.controlsContainer, "Per-axis:", this.showAxes);
        this.statsToggle = checkboxGroup(this.controlsContainer, "Details:", this.showStats);

        this.readout = this._makeRows("error-metrics-readout", READOUT_ROWS);
        this.content.appendChild(this.readout);
        this._applyAxesVisibility();

        this.stats = this._makeRows("error-metrics-stats", STATS_ROWS);
        this.content.appendChild(this.stats);
        // RMSE/max-error/drift summary block, behind the "Details" toggle.
        this.stats.hidden = !this.showStats;

        this.content.appendChild(exportBar(() => this._exportCsv()));

        this.plotDiv = document.createElement("div");
        this.plotDiv.className = "sv-chart";
        this.content.appendChild(this.plotDiv);
    }

    // A block of "label ... value" rows from a [label, color, key] table;
    // `block.rows[key]` is each row, `block.values[key]` its value span. A
    // `color` prepends a small square in that color to the label, so the row
    // doubles as the legend entry for its plot series.
    _makeRows(className, table) {
        const block = document.createElement("div");
        block.className = className;
        block.rows = {};
        block.values = {};
        for (const [labelText, color, key] of table) {
            const row = document.createElement("div");
            const label = document.createElement("span");
            if (color) {
                const swatch = document.createElement("span");
                swatch.className = "error-metrics-swatch";
                swatch.style.backgroundColor = color;
                label.appendChild(swatch);
            }
            label.appendChild(document.createTextNode(labelText));
            const valueSpan = document.createElement("span");
            valueSpan.textContent = "-";
            row.appendChild(label);
            row.appendChild(valueSpan);
            block.appendChild(row);
            block.rows[key] = row;
            block.values[key] = valueSpan;
        }
        return block;
    }

    // Shows the combined-magnitude readout row or the per-axis rows,
    // whichever matches the current toggle state.
    _applyAxesVisibility() {
        const rows = this.readout.rows;
        rows.pos.hidden = this.showAxes;
        rows.x.hidden = rows.y.hidden = rows.z.hidden = !this.showAxes;
    }

    // Called after a batch is renamed elsewhere (e.g. the BatchLegend), so the
    // Batch A/B dropdowns don't keep showing a stale name.
    refreshBatchLabels() {
        for (const select of [this.batchASelect, this.batchBSelect]) {
            for (const option of select.options) {
                const batchIndex = parseInt(option.value);
                option.textContent = `${batchIndex}: ${this.app.batchManager.getBatchName(batchIndex)}`;
            }
        }
    }

    _setupEventListeners() {
        this.bodySelect.addEventListener("change", (e) => {
            this.selectedBody = e.target.value;
            this._recompute();
        });
        this.batchASelect.addEventListener("change", (e) => {
            this.batchA = parseInt(e.target.value);
            this._recompute();
        });
        this.batchBSelect.addEventListener("change", (e) => {
            this.batchB = parseInt(e.target.value);
            this._recompute();
        });
        this.axesToggle.addEventListener("change", (e) => {
            this.showAxes = e.target.checked;
            this._applyAxesVisibility();
            this._buildChart();
        });
        this.statsToggle.addEventListener("change", (e) => {
            this.showStats = e.target.checked;
            this.stats.hidden = !this.showStats;
        });
    }

    // Called by AnalysisPanel when this panel becomes/stops being the visible section.
    setVisible(visible) {
        if (this.isExpanded === visible) return;
        this.isExpanded = visible;
        if (this.isExpanded) this._recompute();
    }

    // Called by SimView once body position/quaternion history has been
    // (re)built. Live streaming calls this per pushed frame, and a recompute
    // walks the whole history, so it's deferred to the throttled animate()
    // tick (and skipped entirely while the panel is hidden -- setVisible
    // recomputes on open).
    onHistoryReady() {
        if (!this.app.bodies.has(this.selectedBody)) {
            this.selectedBody = this.app.bodies.keys().next().value || null;
        }
        this._historyDirty = true;
    }

    // Per-frame plain arrays: `times` is the x of every series, the rest are
    // the error values (NaN at a trajectory gap).
    _clearSeries() {
        this.times = [];
        this.posSeries = [];
        this.rotSeries = [];
        this.axisSeries = { x: [], y: [], z: [] };
    }

    _computeSeries() {
        const body = this.app.bodies.get(this.selectedBody);
        if (!body || !body.validStates) {
            this._clearSeries();
            return;
        }
        const store = this.app.animationController ? this.app.animationController.store : null;
        if (!store) {
            this._clearSeries();
            return;
        }

        const posA = body.positionHistory[this.batchA];
        const posB = body.positionHistory[this.batchB];
        const quatA = body.quaternionHistory[this.batchA];
        const quatB = body.quaternionHistory[this.batchB];
        if (!posA || !posB || !quatA || !quatB) {
            this._clearSeries();
            return;
        }

        const n = body.validStates;
        const times = new Array(n);
        const posSeries = new Array(n);
        const rotSeries = new Array(n);
        const axisXSeries = new Array(n);
        const axisYSeries = new Array(n);
        const axisZSeries = new Array(n);
        for (let s = 0; s < n; s++) {
            const { dx, dy, dz } = positionAxisError(posA, posB, s);
            const posErr = positionError(posA, posB, s);
            const rotErrDeg = (quaternionAngleError(quatA, quatB, s) * 180) / Math.PI;

            times[s] = s < store.length ? store.timeAt(s) : s;
            posSeries[s] = posErr;
            rotSeries[s] = rotErrDeg;
            axisXSeries[s] = dx;
            axisYSeries[s] = dy;
            axisZSeries[s] = dz;
        }
        this.times = times;
        this.posSeries = posSeries;
        this.rotSeries = rotSeries;
        this.axisSeries = { x: axisXSeries, y: axisYSeries, z: axisZSeries };
    }

    _recompute() {
        this._historyDirty = false;
        this._computeSeries();
        this._buildChart();
        this._computeStats();
    }

    // Summary statistics over the full timeline for the current
    // body/batch-pair selection: position RMSE, max position error (with the
    // time it occurs at), final-frame drift, orientation RMSE, and max angle
    // error. Displayed compactly below the live readout.
    _computeStats() {
        const v = this.stats.values;
        if (this.posSeries.length === 0) {
            for (const span of Object.values(v)) span.textContent = "-";
            return;
        }

        // NaN frames (gaps in the trajectory) are skipped by rmse/maxWithIndex
        // and shown as "-" here, matching the scalar plots' gap handling.
        const posValues = this.posSeries;
        const rotValues = this.rotSeries;

        const posRmse = rmse(posValues);
        const posMax = maxWithIndex(posValues);
        const drift = posValues[posValues.length - 1];
        const rotRmse = rmse(rotValues);
        const rotMax = maxWithIndex(rotValues);

        v.posRmse.textContent = fmt(posRmse, 3, " m");
        v.posMax.textContent =
            posMax.index < 0
                ? "-"
                : `${posMax.value.toFixed(3)} m (t=${this.times[posMax.index].toFixed(3)})`;
        v.drift.textContent = fmt(drift, 3, " m");
        v.rotRmse.textContent = fmt(rotRmse, 2, "°");
        v.rotMax.textContent = rotMax.index < 0 ? "-" : `${rotMax.value.toFixed(2)}°`;
    }

    // Downloads the current selection's per-frame series as CSV: time,
    // combined position error, signed per-axis error, and orientation angle
    // error (degrees, matching the chart/readout convention).
    _exportCsv() {
        if (this.posSeries.length === 0) return;
        const header = ["time", "pos_error", "err_x", "err_y", "err_z", "angle_error_deg"];
        const rows = this.times.map((t, i) => [
            t,
            this.posSeries[i],
            this.axisSeries.x[i],
            this.axisSeries.y[i],
            this.axisSeries.z[i],
            this.rotSeries[i],
        ]);
        const csv = rowsToCsv(header, rows);
        const bodyPart = sanitizeForFilename(this.selectedBody);
        const batchAPart = sanitizeForFilename(this.app.batchManager.getBatchName(this.batchA));
        const batchBPart = sanitizeForFilename(this.app.batchManager.getBatchName(this.batchB));
        const filename = `error_metrics_${bodyPart}_${batchAPart}_vs_${batchBPart}.csv`;
        downloadCsv(filename, csv);
    }

    _buildChart() {
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
        if (this.posSeries.length === 0) {
            return;
        }

        const rotValues = this.rotSeries.map(gapOrValue);

        const seriesConfigs = [{}];
        const dataArrays = [this.times];
        if (this.showAxes) {
            seriesConfigs.push(
                { label: "X error", stroke: SERIES_COLORS.x, width: 1, points: { show: false }, scale: "pos" },
                { label: "Y error", stroke: SERIES_COLORS.y, width: 1, points: { show: false }, scale: "pos" },
                { label: "Z error", stroke: SERIES_COLORS.z, width: 1, points: { show: false }, scale: "pos" }
            );
            dataArrays.push(
                this.axisSeries.x.map(gapOrValue),
                this.axisSeries.y.map(gapOrValue),
                this.axisSeries.z.map(gapOrValue)
            );
        } else {
            seriesConfigs.push({
                label: "Position error",
                stroke: SERIES_COLORS.pos,
                width: 1,
                points: { show: false },
                scale: "pos",
            });
            dataArrays.push(this.posSeries.map(gapOrValue));
        }
        seriesConfigs.push({
            label: "Orientation error",
            stroke: SERIES_COLORS.rot,
            width: 1,
            points: { show: false },
            scale: "rot",
        });
        dataArrays.push(rotValues);

        this.chart = makeChart(
            this.plotDiv,
            {
                // Extra right padding: uPlot sizes the right axis for its
                // tick values, and the rotated right-axis label overhangs it.
                padding: [8, 16, 0, 0],
                series: seriesConfigs,
                scales: {
                    x: { time: false },
                    pos: this.showAxes
                        ? {
                              // min/max are uPlot's extents over the non-null
                              // data (null for an all-gap series).
                              range: (u, min, max) => {
                                  const m = Math.max(Math.abs(min ?? 0), Math.abs(max ?? 0), 1e-6);
                                  return [-m * 1.05, m * 1.05];
                              },
                          }
                        : { range: (u, min, max) => [0, (max ?? 0) * 1.01 || 1] },
                    rot: { range: (u, min, max) => [0, (max ?? 0) * 1.01 || 1] },
                },
                axes: [
                    {
                        show: true,
                        stroke: THEME.overlay0,
                        grid: { show: false },
                        ticks: { show: false },
                        size: 24, // uPlot's default 50px leaves an empty strip under the labels
                        font: THEME.chartFont,
                    },
                    {
                        scale: "pos",
                        show: true,
                        side: 3,
                        label: "Position (m)",
                        labelFont: THEME.chartFont,
                        stroke: this.showAxes ? THEME.subtext0 : SERIES_COLORS.pos,
                        grid: { stroke: THEME.surface0, width: 1 },
                        ticks: { stroke: THEME.surface1 },
                        font: THEME.chartFont,
                    },
                    {
                        scale: "rot",
                        show: true,
                        side: 1,
                        label: "Orient. (°)", // short enough for the rotated label to fit a short panel
                        labelFont: THEME.chartFont,
                        stroke: SERIES_COLORS.rot,
                        grid: { show: false },
                        ticks: { stroke: THEME.surface1 },
                        font: THEME.chartFont,
                    },
                ],
                tooltip: (u, idx) => this._tooltipHtml(u, idx),
                markerTime: () => this.markerTime,
            },
            dataArrays,
            this.app
        );
    }

    _tooltipHtml(u, idx) {
        const time = u.data[0][idx];
        let html = `Time: ${time.toFixed(3)}<br>`;
        if (this.showAxes) {
            const x = u.data[1][idx];
            const y = u.data[2][idx];
            const z = u.data[3][idx];
            const rot = u.data[4][idx];
            html +=
                `<span style="color:${SERIES_COLORS.x};">X: ${fmt(x, 3, " m")}</span><br>` +
                `<span style="color:${SERIES_COLORS.y};">Y: ${fmt(y, 3, " m")}</span><br>` +
                `<span style="color:${SERIES_COLORS.z};">Z: ${fmt(z, 3, " m")}</span><br>` +
                `<span style="color:${SERIES_COLORS.rot};">Orientation: ${fmt(rot, 2, "°")}</span>`;
        } else {
            const pos = u.data[1][idx];
            const rot = u.data[2][idx];
            html +=
                `<span style="color:${SERIES_COLORS.pos};">Position: ${fmt(pos, 3, " m")}</span><br>` +
                `<span style="color:${SERIES_COLORS.rot};">Orientation: ${fmt(rot, 2, "°")}</span>`;
        }
        return html;
    }

    _updateReadoutAndMarker() {
        if (!this.app.animationController) return;
        const idx = this.app.animationController.currentStateIndex;
        const v = this.readout.values;
        if (this.showAxes) {
            for (const key of ["x", "y", "z"]) {
                v[key].textContent = fmt(this.axisSeries[key][idx], 3, " m");
            }
        } else {
            v.pos.textContent = fmt(this.posSeries[idx], 3, " m");
        }
        v.rot.textContent = fmt(this.rotSeries[idx], 2, "°");

        const time = this.times[idx];
        if (this.chart && time !== undefined) {
            if (this.markerTime !== time) {
                this.markerTime = time;
                this.chart.redraw(false, false);
            }
        }
    }

    animate(now) {
        if (!this.isExpanded) return;
        if (now - this.lastRenderTime < this.minRenderDelay) return;
        this.lastRenderTime = now;
        if (this._historyDirty) this._recompute();
        this._updateReadoutAndMarker();
    }

    dispose() {
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    }
}
