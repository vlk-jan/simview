import { FREQ_CONFIG, THEME } from "../config.js";
import { downloadCsv, sanitizeForFilename } from "../utils/csv.js";
import { buildTerrainSeries } from "../utils/terrainSample.js";
import { makeChart, yIncrements } from "../utils/uplot.js";
import { batchColumnsCsv, closestSeries, exportBar, selectGroup } from "./chartControls.js";

const LAYER_LABELS = { height: "Height" };

// Terrain analysis tab: samples a terrain layer (height, or any named
// property, e.g. friction/stiffness) under a body's path over time, one
// uPlot series per batch, so a
// divergence onset (e.g. in Error Metrics) can be correlated with a
// terrain-property difference under the body at that time -- the DRIFT
// use case is plotting each batch's terrain under GT's own path. The whole
// trajectory is plotted immediately (not revealed progressively as playback
// advances), with a moving marker line for the current time -- mirrors
// ErrorMetrics's chart pattern; controls are selects like ErrorMetrics since
// the picked layer/body/path -- not a fixed tab -- decides what's plotted.
export class TerrainProfile {
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
        this.bodyNames = [...this.app.bodies].filter(([, b]) => b.hasPose).map(([n]) => n);
        this.selectedBody = this.bodyNames[0] ?? null;
        this.pathMode = "own"; // "own", or a batch index (string) to sample every batch along

        this.times = [];
        this.fullSeries = []; // per batch: {x: time, y: value}[], the complete precomputed series
        this.markerTime = null;
        this.chart = null;
        this.minRenderDelay = 1000 / FREQ_CONFIG.terrainProfile;
        this.lastRenderTime = Number.NEGATIVE_INFINITY;

        this._setupHTML();
        this._setupEventListeners();
    }

    _setupHTML() {
        this.content = document.createElement("div");
        this.content.className = "terrain-profile-content";

        this.controlsContainer = document.createElement("div");
        this.controlsContainer.className = "terrain-profile-controls";
        this.content.appendChild(this.controlsContainer);

        this.layerSelect = selectGroup(
            this.controlsContainer,
            "Layer:",
            this.availableLayers.map((l) => ({ value: l, label: LAYER_LABELS[l] || l })),
            this.layer
        );

        // Only shown when there's an actual choice to make -- a single-body
        // scene has nothing to pick.
        this.bodySelect = null;
        if (this.bodyNames.length > 1) {
            this.bodySelect = selectGroup(
                this.controlsContainer,
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
        this.pathSelect = selectGroup(this.controlsContainer, "Path:", pathOptions, this.pathMode);

        this.content.appendChild(exportBar(() => this._exportCsv()));

        this.plotDiv = document.createElement("div");
        this.plotDiv.className = "sv-chart";
        this.content.appendChild(this.plotDiv);
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
            this._updateMarker(true);
        }
    }

    _gridForLayer(layer) {
        const terrain = this.app.terrain;
        if (layer === "height") return terrain.heightData;
        return terrain.properties.get(layer);
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
        this._updateMarker(true);
    }

    _buildChart() {
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
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
        const dataArrays = [this.times];
        for (let i = 0; i < numBatches; i++) {
            seriesConfigs.push({
                label: this.app.batchManager.getBatchName(i),
                stroke: this.app.batchManager.getColorForBatch(i),
                width: 1,
                points: { show: false },
            });
            const batchSeries = this.fullSeries[i] || [];
            dataArrays.push(batchSeries.map((p) => p.y));
        }

        this.chart = makeChart(
            this.plotDiv,
            {
                series: seriesConfigs,
                scales: {
                    x: { time: false },
                    y: { min, max },
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
                        show: true,
                        stroke: THEME.subtext0,
                        grid: { stroke: THEME.surface0, width: 1 },
                        ticks: { stroke: THEME.surface1 },
                        font: THEME.chartFont,
                        space: 30,
                        incrs: yIncrements(min, max),
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
        const batchIndex = closestSeries(u, idx, u.posToVal(u.cursor.top, "y"));
        if (batchIndex < 0) return null;
        const time = u.data[0][idx];
        const value = u.data[batchIndex + 1][idx];
        const color = this.app.batchManager.getColorForBatch(batchIndex);
        const batchLabel = this.app.batchManager.getBatchName(batchIndex);
        const layerLabel = LAYER_LABELS[this.layer] || this.layer;
        return `<span style="color:${color};">Batch: ${batchLabel}<br>Time: ${time.toFixed(3)}<br>${layerLabel}: ${value.toFixed(3)}</span>`;
    }

    // Moves the current-time marker line to match playback, redrawing only
    // the cheap marker overlay (not the series paths) when it actually
    // shifts -- mirrors ErrorMetrics._updateReadoutAndMarker.
    _updateMarker(force = false) {
        if (!this.chart || this.times.length === 0 || !this.app.animationController) return;
        const idx = this.app.animationController.getCurrentStateIndex();
        const clamped = Math.max(0, Math.min(idx, this.times.length - 1));
        const time = this.times[clamped];
        if (this.markerTime === time && !force) return;
        this.markerTime = time;
        this.chart.redraw(false, false);
    }

    // Downloads the current selection's full series as CSV: time, then one
    // column per batch (named after the batch's current display name).
    _exportCsv() {
        if (this.fullSeries.length === 0 || this.times.length === 0) return;
        const csv = batchColumnsCsv(this.app.batchManager, this.times, this.fullSeries);
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
        this._updateMarker();
    }

    dispose() {
        if (this.chart) {
            this.chart.destroy();
            this.chart = null;
        }
    }
}
