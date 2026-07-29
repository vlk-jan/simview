import uPlot from "../../lib/uPlot.esm.js";
import { FREQ_CONFIG } from "../config.js";
import { downloadCsv, rowsToCsv, sanitizeForFilename } from "../utils/csv.js";
import { injectStyles } from "../utils/injectStyles.js";
import { buildTerrainSeries } from "../utils/terrainSample.js";

const LAYER_LABELS = { height: "Height", friction: "Friction", stiffness: "Stiffness" };

// Terrain analysis tab: samples a terrain layer (height/friction/stiffness)
// under a body's path over time, one uPlot series per batch, so a
// divergence onset (e.g. in Error Metrics) can be correlated with a
// terrain-property difference under the body at that time -- the DRIFT
// use case is plotting each batch's terrain under GT's own path. Structure
// mirrors ScalarPlotter (single shared x-axis, progressive reveal tied to
// playback, CSV export); controls are selects like ErrorMetrics since the
// picked layer/body/path -- not a fixed tab -- decides what's plotted.
export class TerrainProfile {
    static styleId = "terrain-profile-styles";

    constructor(app) {
        this.app = app;
        this.isExpanded = false;
        // Sampling a whole trajectory is more expensive than the simple
        // math ErrorMetrics does, so recomputation is deferred until the
        // tab is actually opened (see setVisible/_onControlChange) rather
        // than eagerly on every control change.
        this.dirty = true;

        this.availableLayers = this.app.terrain.getAvailableDiffLayers();
        if (this.availableLayers.length === 0) this.availableLayers = ["height"];
        this.layer = this.availableLayers[0];
        this.bodyNames = [...this.app.bodies.keys()];
        this.selectedBody = this.bodyNames[0] ?? null;
        this.pathMode = "own"; // "own", or a batch index (string) to sample every batch along

        this.times = [];
        this.fullSeries = []; // per batch: {x: time, y: value}[], the complete precomputed series
        this.currentEndIndex = 0;
        this.chart = null;
        this.resizeObserver = null;
        this.seriesRenderCallback = null;
        this.minRenderDelay = 1000 / (FREQ_CONFIG.terrainProfile || FREQ_CONFIG.scalarPlotter);
        this.lastRenderTime = Number.NEGATIVE_INFINITY;

        this._injectStyles();
        this._setupHTML();
        this._setupEventListeners();
    }

    _injectStyles() {
        const css = `
        .terrain-profile-content {
            padding: 10px;
        }
        .terrain-profile-controls {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            row-gap: 6px;
            gap: 10px;
        }
        .terrain-profile-control-group {
            display: flex;
            align-items: center;
            gap: 5px;
        }
        .terrain-profile-control-group label {
            color: #ccc;
            font-size: 0.9em;
            white-space: nowrap;
        }
        .terrain-profile-control-group select {
            background-color: rgba(50, 50, 50, 0.8);
            color: white;
            border: 1px solid white;
            padding: 0.1em 0.2em;
            border-radius: 3px;
            font-size: 0.9em;
            max-width: 160px;
        }
        .terrain-profile-export-bar {
            display: flex;
            justify-content: flex-end;
            margin-top: 8px;
        }
        .terrain-profile-export-bar button {
            background-color: rgba(50, 50, 50, 0.8);
            color: white;
            border: 1px solid white;
            padding: 0.2em 0.6em;
            border-radius: 3px;
            font-size: 0.85em;
            cursor: pointer;
        }
        .terrain-profile-plot {
            width: 100%;
            height: 15vh;
            margin-top: 10px;
            position: relative;
            background-color: rgba(0, 0, 0, 1);
            cursor: pointer;
        }
        .terrain-profile-plot .uplot,
        .terrain-profile-plot .u-wrap {
            width: 100%;
            height: 100%;
        }
        .terrain-profile-plot .u-legend {
            display: none;
        }
        `;
        injectStyles(TerrainProfile.styleId, css);
    }

    _setupHTML() {
        this.content = document.createElement("div");
        this.content.className = "terrain-profile-content";

        this.controlsContainer = document.createElement("div");
        this.controlsContainer.className = "terrain-profile-controls";
        this.content.appendChild(this.controlsContainer);

        this.layerSelect = this._addSelectGroup(
            "Layer:",
            this.availableLayers.map((l) => ({ value: l, label: LAYER_LABELS[l] || l })),
            this.layer
        );

        // Only shown when there's an actual choice to make -- a single-body
        // scene has nothing to pick.
        this.bodySelect = null;
        if (this.bodyNames.length > 1) {
            this.bodySelect = this._addSelectGroup(
                "Body:",
                this.bodyNames.map((n) => ({ value: n, label: n })),
                this.selectedBody
            );
        }

        const pathOptions = [{ value: "own", label: "Own path" }];
        const simBatches = this.app.batchManager.simBatches;
        if (simBatches > 1) {
            for (let i = 0; i < simBatches; i++) {
                pathOptions.push({
                    value: String(i),
                    label: `Path of ${this.app.batchManager.getBatchName(i)}`,
                });
            }
        }
        this.pathSelect = this._addSelectGroup("Path:", pathOptions, this.pathMode);

        this.exportContainer = document.createElement("div");
        this.exportContainer.className = "terrain-profile-export-bar";
        this.exportButton = document.createElement("button");
        this.exportButton.textContent = "Export CSV";
        this.exportContainer.appendChild(this.exportButton);
        this.content.appendChild(this.exportContainer);

        this.plotDiv = document.createElement("div");
        this.plotDiv.className = "terrain-profile-plot";
        this.content.appendChild(this.plotDiv);
    }

    _addSelectGroup(labelText, options, selectedValue) {
        const group = document.createElement("div");
        group.className = "terrain-profile-control-group";
        const label = document.createElement("label");
        label.textContent = labelText;
        const select = document.createElement("select");
        options.forEach(({ value, label: optLabel }) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = optLabel;
            if (value === selectedValue) option.selected = true;
            select.appendChild(option);
        });
        group.appendChild(label);
        group.appendChild(select);
        this.controlsContainer.appendChild(group);
        return select;
    }

    _setupEventListeners() {
        this.layerSelect.addEventListener("change", (e) => {
            this.layer = e.target.value;
            this._onControlChange();
        });
        if (this.bodySelect) {
            this.bodySelect.addEventListener("change", (e) => {
                this.selectedBody = e.target.value;
                this._onControlChange();
            });
        }
        this.pathSelect.addEventListener("change", (e) => {
            this.pathMode = e.target.value;
            this._onControlChange();
        });
        this.exportButton.addEventListener("click", () => this._exportCsv());
    }

    _onControlChange() {
        this.dirty = true;
        if (this.isExpanded) this._recompute();
    }

    // Called after a batch is renamed elsewhere (e.g. the BatchLegend), so
    // the path picker's "Path of <name>" options don't keep showing a stale
    // name. Mirrors ErrorMetrics.refreshBatchLabels.
    refreshBatchLabels() {
        for (const option of this.pathSelect.options) {
            if (option.value === "own") continue;
            const batchIndex = parseInt(option.value, 10);
            option.textContent = `Path of ${this.app.batchManager.getBatchName(batchIndex)}`;
        }
    }

    // Called by AnalysisPanel when this panel becomes/stops being the visible section.
    setVisible(visible) {
        if (this.isExpanded === visible) return;
        this.isExpanded = visible;
        if (!this.isExpanded) return;

        if (this.dirty) {
            this._recompute();
        } else {
            this._resizeChart();
            if (this.app.animationController) {
                this.setEndIndex(this.app.animationController.getCurrentStateIndex(), true);
            }
            this._renderChart();
        }
    }

    _gridForLayer(layer) {
        const terrain = this.app.terrain;
        if (layer === "friction") return terrain.frictionData;
        if (layer === "stiffness") return terrain.stiffnessData;
        return terrain.heightData;
    }

    // Builds the per-batch [x, y] path (local/un-offset, same frame terrain
    // bounds are defined in) that terrainSample.js walks, from a body's
    // position history -- see Body.js's positionHistory (Float32Array of
    // flat [x,y,z] triples, one per frame, per batch).
    _buildPaths(body) {
        const simBatches = this.app.batchManager.simBatches;
        const paths = new Array(simBatches);
        const numFrames = body ? body.validStates || 0 : 0;
        for (let b = 0; b < simBatches; b++) {
            const flat = body && body.positionHistory[b];
            if (!flat) {
                paths[b] = [];
                continue;
            }
            const path = new Array(numFrames);
            for (let s = 0; s < numFrames; s++) {
                const base = s * 3;
                path[s] = [flat[base], flat[base + 1]];
            }
            paths[b] = path;
        }
        return paths;
    }

    // Recomputes the full (whole-timeline) series for the current
    // layer/body/path selection. This is the expensive step (bilinear
    // sampling every frame x every batch) -- only run on open or on a
    // control change while open, never per animation frame.
    _recompute() {
        this.dirty = false;
        const store = this.app.animationController ? this.app.animationController.store : null;
        const terrain = this.app.terrain;
        const body = this.selectedBody ? this.app.bodies.get(this.selectedBody) : null;

        if (!store || !terrain || !body) {
            this.times = [];
            this.fullSeries = [];
        } else {
            const grid = this._gridForLayer(this.layer) || [];
            const paths = this._buildPaths(body);
            const referenceBatch = this.pathMode === "own" ? null : parseInt(this.pathMode, 10);
            this.times = store.times;
            this.fullSeries = buildTerrainSeries({
                times: this.times,
                paths,
                grids: grid,
                dimensions: terrain.dimensions,
                bounds: terrain.bounds,
                isSingleton: terrain.isSingleton,
                referenceBatch,
            });
        }

        this._buildChart();
        const idx = this.app.animationController ? this.app.animationController.getCurrentStateIndex() : 0;
        this.setEndIndex(idx, true);
        this._renderChart();
    }

    _chartInterval(min, max) {
        const diff = max - min;
        if (diff === 0) return Math.max(Math.abs(max) / 5, 1e-3);
        return diff / 5;
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
        if (this.fullSeries.length === 0 || this.times.length === 0) return;

        const numBatches = this.app.batchManager.simBatches;
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (const batchSeries of this.fullSeries) {
            for (const { y } of batchSeries) {
                if (y < min) min = y;
                if (y > max) max = y;
            }
        }
        if (!Number.isFinite(min) || !Number.isFinite(max)) {
            min = 0;
            max = 1;
        }
        const limOffset = 1e-2;
        min -= limOffset;
        max += limOffset;

        const seriesConfigs = [{}];
        for (let i = 0; i < numBatches; i++) {
            seriesConfigs.push({
                label: this.app.batchManager.getBatchName(i),
                stroke: this.app.batchManager.getColorForBatch(i),
                width: 1,
                points: { show: false },
            });
        }

        const rect = this.plotDiv.getBoundingClientRect();
        this.chart = new uPlot(
            {
                width: Math.max(rect.width, 1),
                height: Math.max(rect.height, 1),
                padding: [8, 8, 0, 8],
                series: seriesConfigs,
                scales: {
                    x: { time: false, min: this.times[0], max: this.times[this.times.length - 1] },
                    y: { min, max },
                },
                axes: [
                    {
                        show: true,
                        stroke: "transparent",
                        grid: { show: false },
                        ticks: { show: false },
                        values: () => [],
                    },
                    {
                        show: true,
                        stroke: "white",
                        grid: { stroke: "rgb(53, 53, 53)", width: 1 },
                        ticks: { stroke: "rgb(73, 73, 73)" },
                        font: "12px Arial",
                        space: 30,
                        incrs: [this._chartInterval(min, max)],
                    },
                ],
                legend: { show: false },
                cursor: {
                    drag: { x: false, y: false },
                    points: { show: false },
                },
                hooks: {
                    setCursor: [(u) => this._updateTooltip(u)],
                },
            },
            [[], ...new Array(numBatches).fill([])],
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

        this.resizeObserver = new ResizeObserver(() => this._resizeChart());
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

    // Finds the batch series whose y-value at the hovered x-index is closest
    // to the hovered y-pixel, same approach as ScalarPlotter.
    _closestSeriesAtIndex(u, dataIdx, yVal) {
        let bestBatch = -1;
        let bestDist = Infinity;
        for (let i = 0; i < this.app.batchManager.simBatches; i++) {
            const y = u.data[i + 1][dataIdx];
            if (y === null || y === undefined) continue;
            const dist = Math.abs(y - yVal);
            if (dist < bestDist) {
                bestDist = dist;
                bestBatch = i;
            }
        }
        return bestBatch;
    }

    _updateTooltip(u) {
        if (!this._tooltip) return;
        const idx = u.cursor.idx;
        if (idx === null || idx === undefined || u.cursor.left < 0) {
            this._tooltip.style.display = "none";
            return;
        }
        const yVal = u.posToVal(u.cursor.top, "y");
        const batchIndex = this._closestSeriesAtIndex(u, idx, yVal);
        if (batchIndex < 0) {
            this._tooltip.style.display = "none";
            return;
        }
        const time = u.data[0][idx];
        const value = u.data[batchIndex + 1][idx];
        if (value === null || value === undefined) {
            this._tooltip.style.display = "none";
            return;
        }
        const batchLabel = this.app.batchManager.getBatchName(batchIndex);
        const color = this.app.batchManager.getColorForBatch(batchIndex);

        this._tooltip.style.color = color;
        this._tooltip.innerHTML = `Batch: ${batchLabel}<br>Time: ${time.toFixed(3)}<br>${LAYER_LABELS[this.layer] || this.layer}: ${value.toFixed(3)}`;
        this._tooltip.style.display = "block";
        this._tooltip.style.left = `${u.cursor.left + 12}px`;
        this._tooltip.style.top = `${u.cursor.top + 12}px`;
    }

    _resizeChart() {
        if (!this.chart || !this.plotDiv) return;
        const rect = this.plotDiv.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        this.chart.setSize({ width: rect.width, height: rect.height });
    }

    // Reveals the precomputed series up to `newEndIndex`, mirroring
    // ScalarPlotter's progressive-reveal-tied-to-playback cursor sync --
    // cheap (a slice of already-sampled data), unlike _recompute.
    setEndIndex(newEndIndex, force = false) {
        if (this.times.length === 0) return;
        const clamped = Math.max(0, Math.min(newEndIndex, this.times.length - 1));
        if (this.currentEndIndex === clamped && !force) return;
        this.currentEndIndex = clamped;
        if (!this.chart) return;

        this.seriesRenderCallback = () => {
            const numPoints = this.currentEndIndex + 1;
            const xValues = this.times.slice(0, numPoints);
            const data = [xValues];
            for (let i = 0; i < this.app.batchManager.simBatches; i++) {
                const batchSeries = this.fullSeries[i] || [];
                data.push(batchSeries.slice(0, numPoints).map((p) => p.y));
            }
            this.chart.setData(data, false);
        };
    }

    _renderChart() {
        if (!this.chart || !this.seriesRenderCallback) return;
        this.seriesRenderCallback();
        this.seriesRenderCallback = null;
        this.chart.redraw(false, true);
    }

    // Downloads the current selection's full series as CSV: time, then one
    // column per batch (named after the batch's current display name).
    _exportCsv() {
        if (this.fullSeries.length === 0 || this.times.length === 0) return;
        const batchCount = this.app.batchManager.simBatches;
        const header = ["time"];
        for (let i = 0; i < batchCount; i++) {
            header.push(this.app.batchManager.getBatchName(i) || `batch_${i}`);
        }
        const rows = this.times.map((t, idx) => {
            const row = [t];
            for (let i = 0; i < batchCount; i++) {
                const point = this.fullSeries[i] && this.fullSeries[i][idx];
                row.push(point ? point.y : "");
            }
            return row;
        });
        const csv = rowsToCsv(header, rows);
        const layerPart = sanitizeForFilename(this.layer);
        const bodyPart = sanitizeForFilename(this.selectedBody || "");
        const pathPart =
            this.pathMode === "own"
                ? "own"
                : sanitizeForFilename(
                      `path_${this.app.batchManager.getBatchName(parseInt(this.pathMode, 10))}`
                  );
        downloadCsv(`terrain_${layerPart}_${bodyPart}_${pathPart}.csv`, csv);
    }

    animate(now) {
        if (!this.isExpanded) return;
        if (now - this.lastRenderTime < this.minRenderDelay) return;
        this.lastRenderTime = now;
        if (this.app.animationController) {
            this.setEndIndex(this.app.animationController.getCurrentStateIndex());
        }
        this._renderChart();
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
