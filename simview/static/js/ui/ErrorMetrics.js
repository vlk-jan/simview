import uPlot from "../../lib/uPlot.esm.js";
import { FREQ_CONFIG } from "../config.js";

// Compares two batches of the same body over the full timeline: Euclidean
// position error and quaternion angle (orientation) error. Useful for e.g.
// comparing a real-world recording batch against a simulated rerun batch.
export class ErrorMetrics {
    static cssInjected = false;
    static styleId = "error-metrics-styles";

    constructor(app) {
        this.app = app;
        this.isExpanded = false;
        this.selectedBody = app.bodies.keys().next().value || null;
        this.batchA = 0;
        this.batchB = Math.min(1, app.batchManager.simBatches - 1);
        this.posSeries = [];
        this.rotSeries = [];
        this.minRenderDelay = 1000 / FREQ_CONFIG.errorMetrics;
        this.lastRenderTime = Number.NEGATIVE_INFINITY;
        this.chart = null;
        this.resizeObserver = null;
        this.markerTime = null;

        this._injectStyles();
        this._setupHTML();
        this._setupEventListeners();
    }

    _injectStyles() {
        if (ErrorMetrics.cssInjected || document.getElementById(ErrorMetrics.styleId)) {
            ErrorMetrics.cssInjected = true;
            return;
        }
        const css = `
        .error-metrics-content {
            padding: 10px;
        }
        .error-metrics-controls {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            margin-top: 8px;
        }
        .error-metrics-control-group {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .error-metrics-control-group label {
            color: #ccc;
            font-size: 0.9em;
            white-space: nowrap;
        }
        .error-metrics-control-group select {
            background-color: rgba(50, 50, 50, 0.8);
            color: white;
            border: 1px solid white;
            padding: 0.1em 0.2em;
            border-radius: 3px;
            font-size: 0.9em;
            max-width: 100px;
        }
        .error-metrics-readout {
            margin-top: 10px;
            font-family: monospace;
        }
        .error-metrics-readout div {
            display: flex;
            justify-content: space-between;
            padding: 2px 0;
        }
        .error-metrics-plot {
            width: 100%;
            height: 15vh;
            margin-top: 10px;
            position: relative;
            background-color: rgba(0, 0, 0, 1);
            cursor: pointer;
        }
        .error-metrics-plot .uplot,
        .error-metrics-plot .u-wrap {
            width: 100%;
            height: 100%;
        }
        .error-metrics-plot .u-legend {
            display: none;
        }
        `;
        const styleElement = document.createElement("style");
        styleElement.id = ErrorMetrics.styleId;
        styleElement.textContent = css;
        document.head.appendChild(styleElement);
        ErrorMetrics.cssInjected = true;
    }

    _setupHTML() {
        this.content = document.createElement("div");
        this.content.className = "error-metrics-content";

        this.controlsContainer = document.createElement("div");
        this.controlsContainer.className = "error-metrics-controls";
        this.content.appendChild(this.controlsContainer);

        this.bodySelect = this._addSelectGroup("Body:", [...this.app.bodies.keys()], this.selectedBody);
        const batchOptions = [...Array(this.app.batchManager.simBatches).keys()];
        this.batchASelect = this._addSelectGroup("Batch A:", batchOptions, this.batchA, true);
        this.batchBSelect = this._addSelectGroup("Batch B:", batchOptions, this.batchB, true);

        this.readout = document.createElement("div");
        this.readout.className = "error-metrics-readout";
        this.posReadout = document.createElement("div");
        this.posReadout.innerHTML = "<span>Position error:</span><span>-</span>";
        this.rotReadout = document.createElement("div");
        this.rotReadout.innerHTML = "<span>Orientation error:</span><span>-</span>";
        this.readout.appendChild(this.posReadout);
        this.readout.appendChild(this.rotReadout);
        this.content.appendChild(this.readout);

        this.plotDiv = document.createElement("div");
        this.plotDiv.className = "error-metrics-plot";
        this.content.appendChild(this.plotDiv);
    }

    _addSelectGroup(labelText, options, selected, isBatch = false) {
        const group = document.createElement("div");
        group.className = "error-metrics-control-group";
        const label = document.createElement("label");
        label.textContent = labelText;
        const select = document.createElement("select");
        options.forEach((opt) => {
            const option = document.createElement("option");
            option.value = opt;
            option.textContent = isBatch
                ? `${opt}: ${this.app.batchManager.getBatchName(opt)}`
                : opt;
            if (opt === selected) option.selected = true;
            select.appendChild(option);
        });
        group.appendChild(label);
        group.appendChild(select);
        this.controlsContainer.appendChild(group);
        return select;
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
    }

    // Called by AnalysisPanel when this panel becomes/stops being the visible section.
    setVisible(visible) {
        if (this.isExpanded === visible) return;
        this.isExpanded = visible;
        if (this.isExpanded) this._recompute();
    }

    // Called by SimView once body position/quaternion history has been (re)built.
    onHistoryReady() {
        if (!this.app.bodies.has(this.selectedBody)) {
            this.selectedBody = this.app.bodies.keys().next().value || null;
        }
        if (this.isExpanded) this._recompute();
    }

    _computeSeries() {
        const body = this.app.bodies.get(this.selectedBody);
        if (!body || !body.validStates) {
            this.posSeries = [];
            this.rotSeries = [];
            return;
        }
        const states = this.app.animationController ? this.app.animationController.states : null;
        if (!states) {
            this.posSeries = [];
            this.rotSeries = [];
            return;
        }

        const posA = body.positionHistory[this.batchA];
        const posB = body.positionHistory[this.batchB];
        const quatA = body.quaternionHistory[this.batchA];
        const quatB = body.quaternionHistory[this.batchB];
        if (!posA || !posB || !quatA || !quatB) {
            this.posSeries = [];
            this.rotSeries = [];
            return;
        }

        const n = body.validStates;
        const posSeries = new Array(n);
        const rotSeries = new Array(n);
        for (let s = 0; s < n; s++) {
            const pBase = s * 3;
            const dx = posA[pBase] - posB[pBase];
            const dy = posA[pBase + 1] - posB[pBase + 1];
            const dz = posA[pBase + 2] - posB[pBase + 2];
            const posErr = Math.sqrt(dx * dx + dy * dy + dz * dz);

            const qBase = s * 4;
            const dot =
                quatA[qBase] * quatB[qBase] +
                quatA[qBase + 1] * quatB[qBase + 1] +
                quatA[qBase + 2] * quatB[qBase + 2] +
                quatA[qBase + 3] * quatB[qBase + 3];
            const clamped = Math.min(1, Math.max(-1, Math.abs(dot)));
            const rotErrDeg = (2 * Math.acos(clamped) * 180) / Math.PI;

            const t = states[s] ? states[s].time : s;
            posSeries[s] = { x: t, y: posErr };
            rotSeries[s] = { x: t, y: rotErrDeg };
        }
        this.posSeries = posSeries;
        this.rotSeries = rotSeries;
    }

    _recompute() {
        this._computeSeries();
        this._buildChart();
    }

    // Draws the current playback time as a vertical marker line over the
    // finished plot.
    _drawMarker(u) {
        if (this.markerTime === null) return;
        const x = u.valToPos(this.markerTime, "x", true);
        if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) return;
        const ctx = u.ctx;
        ctx.save();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, u.bbox.top);
        ctx.lineTo(x, u.bbox.top + u.bbox.height);
        ctx.stroke();
        ctx.restore();
    }

    _buildChart() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
        this.plotDiv.innerHTML = "";
        if (this.posSeries.length === 0) {
            return;
        }

        const xValues = this.posSeries.map((p) => p.x);
        const posValues = this.posSeries.map((p) => p.y);
        const rotValues = this.rotSeries.map((p) => p.y);

        const rect = this.plotDiv.getBoundingClientRect();
        this.chart = new uPlot(
            {
                width: Math.max(rect.width, 1),
                height: Math.max(rect.height, 1),
                padding: [8, 8, 0, 0],
                series: [
                    {},
                    {
                        label: "Position error",
                        stroke: "#4c9aff",
                        width: 1,
                        points: { show: false },
                        scale: "pos",
                    },
                    {
                        label: "Orientation error",
                        stroke: "#ff9f4c",
                        width: 1,
                        points: { show: false },
                        scale: "rot",
                    },
                ],
                scales: {
                    x: { time: false },
                    pos: { range: (u, min, max) => [0, max * 1.01 || 1] },
                    rot: { range: (u, min, max) => [0, max * 1.01 || 1] },
                },
                axes: [
                    {
                        show: true,
                        stroke: "rgba(255, 255, 255, 0.3)",
                        grid: { show: false },
                        ticks: { show: false },
                        font: "12px Arial",
                    },
                    {
                        scale: "pos",
                        show: true,
                        side: 3,
                        label: "Position (m)",
                        labelFont: "12px Arial",
                        stroke: "#4c9aff",
                        grid: { stroke: "rgb(53, 53, 53)", width: 1 },
                        ticks: { stroke: "rgb(73, 73, 73)" },
                        font: "12px Arial",
                    },
                    {
                        scale: "rot",
                        show: true,
                        side: 1,
                        label: "Orientation (deg)",
                        labelFont: "12px Arial",
                        stroke: "#ff9f4c",
                        grid: { show: false },
                        ticks: { stroke: "rgb(73, 73, 73)" },
                        font: "12px Arial",
                    },
                ],
                legend: { show: false },
                cursor: {
                    drag: { x: false, y: false },
                    points: { show: false },
                },
                hooks: {
                    draw: [(u) => this._drawMarker(u)],
                    setCursor: [(u) => this._updateTooltip(u)],
                },
            },
            [xValues, posValues, rotValues],
            this.plotDiv
        );

        this.chart.over.addEventListener("click", (e) => {
            const idx = this.chart.cursor.idx;
            if (idx === null || idx === undefined) return;
            const xVal = this.chart.data[0][idx];
            if (xVal !== undefined && xVal !== null && this.app.animationController) {
                this.app.animationController.goToTime(xVal);
            }
        });

        this._createTooltip();

        this.resizeObserver = new ResizeObserver(() => {
            const r = this.plotDiv.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && this.chart) {
                this.chart.setSize({ width: r.width, height: r.height });
            }
        });
        this.resizeObserver.observe(this.plotDiv);
    }

    _createTooltip() {
        const tooltip = document.createElement("div");
        tooltip.style.cssText =
            "position:absolute;pointer-events:none;display:none;" +
            "background:rgba(20,20,20,0.9);border:1px solid rgba(255,255,255,0.3);" +
            "border-radius:3px;padding:4px 6px;font-family:Arial;font-size:11px;" +
            "color:white;white-space:nowrap;z-index:10;";
        this.plotDiv.appendChild(tooltip);
        this._tooltip = tooltip;
    }

    _updateTooltip(u) {
        if (!this._tooltip) return;
        const idx = u.cursor.idx;
        if (idx === null || idx === undefined || u.cursor.left < 0) {
            this._tooltip.style.display = "none";
            return;
        }
        const time = u.data[0][idx];
        const pos = u.data[1][idx];
        const rot = u.data[2][idx];
        this._tooltip.innerHTML =
            `Time: ${time.toFixed(3)}<br>` +
            `<span style="color:#4c9aff;">Position: ${pos.toFixed(3)} m</span><br>` +
            `<span style="color:#ff9f4c;">Orientation: ${rot.toFixed(2)}°</span>`;
        this._tooltip.style.left = `${u.cursor.left + 12}px`;
        this._tooltip.style.top = `${u.cursor.top + 12}px`;
        this._tooltip.style.display = "block";
    }

    _updateReadoutAndMarker() {
        if (!this.app.animationController) return;
        const idx = this.app.animationController.getCurrentStateIndex();
        const pos = this.posSeries[idx];
        const rot = this.rotSeries[idx];
        this.posReadout.innerHTML = `<span>Position error:</span><span>${pos ? pos.y.toFixed(3) + " m" : "-"}</span>`;
        this.rotReadout.innerHTML = `<span>Orientation error:</span><span>${rot ? rot.y.toFixed(2) + "°" : "-"}</span>`;

        if (this.chart && pos) {
            if (this.markerTime !== pos.x) {
                this.markerTime = pos.x;
                this.chart.redraw(false, false);
            }
        }
    }

    animate(now) {
        if (!this.isExpanded) return;
        if (now - this.lastRenderTime < this.minRenderDelay) return;
        this.lastRenderTime = now;
        this._updateReadoutAndMarker();
    }

    dispose() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    }
}
