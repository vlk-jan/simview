import { FREQ_CONFIG, SCALAR_PLOTTER_CONFIG, THEME } from "../config.js";
import { downloadCsv, sanitizeForFilename } from "../utils/csv.js";
import {
    episodeAggregates,
    episodeIndexAt,
    episodeLabel,
    normalizeEpisodes,
} from "../utils/episodes.js";
import { makeChart, yIncrements } from "../utils/uplot.js";
import { batchColumnsCsv, closestSeries, exportBar, finiteBounds } from "./chartControls.js";
import { appendScalarFrames } from "../utils/scalarSeries.js";

export class ScalarPlotter {
    constructor(app, scalarNames) {
        this.app = app;
        this.scalarNames = scalarNames || [];
        if (this.scalarNames.length === 0) {
            console.warn("No scalar names provided.");
            return;
        }
        this.isExpanded = false;
        this.activeScalar = this.scalarNames[0];
        this.currentEndIndex = 0;
        this.currentFocusedBatch = 0;
        this.plotElements = {};
        this.tabElements = {};
        this.charts = new Map();
        this.scalarSeries = new Map();
        this.scalarBounds = new Map();
        // uPlot's y columns per scalar (NaN -> null gaps), kept so a live
        // append only pushes the new frames instead of remapping the series.
        this.scalarColumns = new Map();
        this.times = [];
        this.store = null;
        this._appendPending = false;
        // Episode boundaries (see utils/episodes.js), drawn over each chart
        // with the focused batch's per-episode aggregate. Empty for an
        // ordinary non-episodic scene, in which case nothing extra is drawn.
        this.rawEpisodes = [];
        this.episodes = [];
        // {scalarName -> per-batch array of per-episode aggregates}, rebuilt
        // only when the episodes or the underlying series change.
        this.episodeAggregateCache = new Map();
        this.markerDirty = false;
        this.opacityRenderCallback = null;
        this.minRenderDelay = 1000 / FREQ_CONFIG.scalarPlotter;
        this.lastRenderTime = Number.NEGATIVE_INFINITY;

        this._setupHTML();
        this._setupEventListeners();
    }

    _setupHTML() {
        this.tabBar = document.createElement("div");
        this.tabBar.className = "scalar-tab-bar";

        this.plotArea = document.createElement("div");
        this.plotArea.className = "scalar-plot-area";

        this.plotArea.appendChild(exportBar(() => this._exportCsv()));

        this.scalarNames.forEach((name, index) => {
            const tabButton = document.createElement("button");
            tabButton.className = "scalar-tab";
            tabButton.textContent = name;
            tabButton.dataset.scalarName = name;
            if (index === 0) tabButton.classList.add("active");
            this.tabBar.appendChild(tabButton);
            this.tabElements[name] = tabButton;

            const plotDiv = document.createElement("div");
            plotDiv.id = `plot-${name}`;
            plotDiv.className = "sv-chart";
            plotDiv.dataset.scalarName = name;
            plotDiv.hidden = index !== 0;
            this.plotArea.appendChild(plotDiv);
            this.plotElements[name] = plotDiv;
        });
    }

    _setupEventListeners() {
        this.tabBar.addEventListener("click", (event) => {
            const target = event.target;
            if (target.classList.contains("scalar-tab")) {
                const scalarName = target.dataset.scalarName;
                if (scalarName && scalarName !== this.activeScalar) {
                    this._switchTab(scalarName);
                }
            }
            event.target.blur();
        });
    }

    // Downloads the active scalar tab's full series as CSV: time, then one
    // column per batch (named after the batch's current display name).
    _exportCsv() {
        const series = this.scalarSeries.get(this.activeScalar);
        if (!series || this.times.length === 0) return;

        const csv = batchColumnsCsv(this.app.batchManager, this.times, series);
        const scalarPart = sanitizeForFilename(this.activeScalar);
        downloadCsv(`scalar_${scalarPart}.csv`, csv);
    }

    // Called by AnalysisPanel when this panel becomes/stops being the visible section.
    setVisible(visible) {
        if (this.isExpanded === visible) return;
        this.isExpanded = visible;

        if (this.isExpanded && this.activeScalar) {
            this.setEndIndex(this.currentEndIndex, true);
            this.setFocusedBatch(this.currentFocusedBatch, true);
        }
    }

    _switchTab(newScalarName) {
        if (
            !this.scalarNames.includes(newScalarName) ||
            newScalarName === this.activeScalar
        ) {
            return;
        }

        const oldTab = this.tabElements[this.activeScalar];
        const oldPlot = this.plotElements[this.activeScalar];
        if (oldTab) oldTab.classList.remove("active");
        if (oldPlot) oldPlot.hidden = true;

        const newTab = this.tabElements[newScalarName];
        const newPlot = this.plotElements[newScalarName];
        if (newTab) newTab.classList.add("active");
        if (newPlot) newPlot.hidden = false;

        this.activeScalar = newScalarName;
        this.setEndIndex(this.currentEndIndex, true);
        this.setFocusedBatch(this.currentFocusedBatch, true);
    }

    initFromStore(store) {
        const batchSize = this.app.batchManager.simBatches;
        this.store = store;
        // Own copy: LegacyStateStore.times is a fresh snapshot per access and
        // the columnar store's array must not be grown by us.
        this.times = Array.from(store.times);
        for (const scalarName of this.scalarNames) {
            // Per-batch series as plain {x, y} points, pulled from the store
            // rather than walked per-frame here -- the columnar store already
            // holds each scalar as one whole-trajectory Float32Array.
            const series = store.getScalarSeries(scalarName, batchSize);
            this.scalarSeries.set(scalarName, series);
            this.scalarBounds.set(scalarName, finiteBounds(series));
            // NaN (a gap in the source) becomes null, uPlot's gap.
            this.scalarColumns.set(
                scalarName,
                series.map((batchSeries) => batchSeries.map(({ y }) => (Number.isFinite(y) ? y : null)))
            );
        }

        this._initializePlots();
        // The timeline length is only known now, so episodes handed over
        // before the store arrived have to be re-normalized against it.
        this._refreshEpisodes();
        if (this.isExpanded) {
            this.setEndIndex(this.currentEndIndex, true);
            this.setFocusedBatch(this.currentFocusedBatch, true);
        }
    }

    // Live streaming appended frames to the store. Coalesced into the
    // throttled animate() tick: pushes land once per frame, charts redraw at
    // FREQ_CONFIG.scalarPlotter Hz.
    onStatesAppended() {
        this._appendPending = true;
    }

    _pullAppended() {
        this._appendPending = false;
        if (!this.store || this.charts.size === 0) return;
        const from = this.times.length;
        if (this.store.length <= from) return;
        appendScalarFrames(
            this.store,
            this.scalarNames,
            this.app.batchManager.simBatches,
            this.times,
            this.scalarSeries,
            this.scalarColumns,
            from
        );
        for (const [name, chart] of this.charts) {
            // Default resetScales: x re-ranges via _timeExtent, y autoscales
            // over the grown data.
            chart.setData([this.times, ...this.scalarColumns.get(name)]);
        }
        // A longer timeline can bring an already-marked episode into range.
        if (this.rawEpisodes.length > 0) this._refreshEpisodes();
    }

    // Episode boundaries from the model (or, in live mode, pushed mid-run).
    // Invalidates the aggregate cache and repaints; safe to call before the
    // store arrives, since initFromStore re-normalizes afterwards.
    setEpisodes(rawEpisodes) {
        this.rawEpisodes = rawEpisodes;
        this._refreshEpisodes();
    }

    _refreshEpisodes() {
        this.episodes = normalizeEpisodes(this.rawEpisodes, this.times.length);
        this.episodeAggregateCache.clear();
        for (const chart of this.charts.values()) chart.redraw();
    }

    // Per-episode aggregates of one scalar, per batch. Cached: recomputing on
    // every uPlot draw would walk the whole trajectory each frame.
    _episodeAggregatesFor(scalarName) {
        let cached = this.episodeAggregateCache.get(scalarName);
        if (cached) return cached;
        const series = this.scalarSeries.get(scalarName);
        if (!series) return [];
        cached = series.map((batchSeries) =>
            episodeAggregates(this.episodes, batchSeries, this.times.length)
        );
        this.episodeAggregateCache.set(scalarName, cached);
        return cached;
    }

    // uPlot `draw` hook: a dashed vertical rule at each episode boundary, plus
    // a horizontal segment at the focused batch's mean across each episode --
    // the "how did this episode do overall" read that per-frame lines bury.
    _drawEpisodeOverlay(u, scalarName) {
        if (this.episodes.length === 0) return;
        const aggregatesByBatch = this._episodeAggregatesFor(scalarName);
        const aggregates = aggregatesByBatch[this.currentFocusedBatch];
        if (!aggregates) return;

        const ctx = u.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
        ctx.clip();

        for (const aggregate of aggregates) {
            const startTime = this.times[aggregate.start];
            if (startTime !== undefined && aggregate.start > 0) {
                const x = u.valToPos(startTime, "x", true);
                ctx.setLineDash([3, 3]);
                ctx.strokeStyle = THEME.overlay0; // episode boundary
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x, u.bbox.top);
                ctx.lineTo(x, u.bbox.top + u.bbox.height);
                ctx.stroke();
            }

            if (aggregate.mean === null) continue;
            const endTime = this.times[Math.min(aggregate.end - 1, this.times.length - 1)];
            if (startTime === undefined || endTime === undefined) continue;
            ctx.setLineDash([]);
            ctx.strokeStyle = THEME.peach; // episode mean
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            const y = u.valToPos(aggregate.mean, "y", true);
            ctx.moveTo(u.valToPos(startTime, "x", true), y);
            ctx.lineTo(u.valToPos(endTime, "x", true), y);
            ctx.stroke();
        }
        ctx.restore();
    }

    // Extra tooltip lines describing the episode the cursor is inside, for the
    // focused batch. `sum` is what an RL run calls the episode return.
    _episodeTooltipText(scalarName, frameIndex) {
        if (this.episodes.length === 0) return "";
        const aggregatesByBatch = this._episodeAggregatesFor(scalarName);
        const aggregates = aggregatesByBatch[this.currentFocusedBatch];
        if (!aggregates) return "";
        const index = episodeIndexAt(this.episodes, frameIndex);
        const aggregate = aggregates.find((a) => a.index === index);
        if (!aggregate || aggregate.mean === null) return "";
        const format = (v) => (Math.abs(v) >= 1e4 ? v.toExponential(2) : v.toFixed(3));
        return (
            `<br>${episodeLabel(aggregate)}: ` +
            `sum ${format(aggregate.sum)}, mean ${format(aggregate.mean)}`
        );
    }

    // The x extent every chart's scale is pinned to: the whole timeline. Falls
    // back to a unit span when there are no times, so uPlot is never handed
    // NaN/undefined bounds.
    _timeExtent() {
        const n = this.times?.length ?? 0;
        if (n === 0) return [0, 1];
        const first = this.times[0];
        const last = this.times[n - 1];
        return last > first ? [first, last] : [first, first + 1];
    }

    _initializePlots() {
        const limOffset = 1e-2;
        this.scalarNames.forEach((name) => {
            const plotDiv = this.plotElements[name];
            var [min, max] = this.scalarBounds.get(name);
            min = min - limOffset;
            max = max + limOffset;

            const series = [{}];
            for (let i = 0; i < this.app.batchManager.simBatches; i++) {
                series.push({
                    label: `${name} ${i}`,
                    stroke: this.app.batchManager.getColorForBatch(i),
                    width: 1,
                    points: { show: false },
                });
            }

            const chart = makeChart(
                plotDiv,
                {
                    series,
                    scales: {
                        // uPlot treats a scale's `min`/`max` as outputs, not as
                        // a pin: the initial autoscale over the empty data
                        // passed below nulls them, and every later update goes
                        // through setData(data, false), which never revisits x.
                        // That left x null forever -- valToPos NaN, nothing
                        // drawn. `range` is the actual pin (the same thing
                        // ErrorMetrics does), and this axis is meant to span the
                        // whole timeline regardless, with the line growing into it.
                        x: { time: false, range: () => this._timeExtent() },
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
                            stroke: THEME.subtext0,
                            grid: { stroke: THEME.surface0, width: 1 },
                            ticks: { stroke: THEME.surface1 },
                            font: THEME.chartFont,
                            space: 30,
                            incrs: yIncrements(min, max, SCALAR_PLOTTER_CONFIG.stepsPerYAxis),
                        },
                    ],
                    tooltip: (u, idx) => this._tooltipHtml(u, idx, name),
                    markerTime: () => this.times[this.currentEndIndex] ?? null,
                    hooks: {
                        draw: [
                            (u) => {
                                this._drawEpisodeOverlay(u, name);
                            },
                        ],
                    },
                    // Beyond the shared seek-on-click, a click also focuses
                    // whichever batch's series passed closest to it.
                    onClick: (chart, idx, e) => {
                        const yVal = chart.posToVal(e.offsetY, "y");
                        const batchIndex = closestSeries(chart, idx, yVal);
                        if (batchIndex >= 0) {
                            this.app.batchManager.setActiveBatch(batchIndex);
                        }
                    },
                },
                // The whole timeline, plotted once; playback only moves the
                // marker (live mode appends via _pullAppended).
                [this.times, ...this.scalarColumns.get(name)],
                this.app
            );

            this.charts.set(name, chart);
        });
    }

    _tooltipHtml(u, idx, name) {
        const batchIndex = closestSeries(u, idx, u.posToVal(u.cursor.top, "y"));
        if (batchIndex < 0) return null;
        const time = u.data[0][idx];
        const value = u.data[batchIndex + 1][idx];
        const color = this.app.batchManager.getColorForBatch(batchIndex);
        const batchLabel = this.app.batchManager.getBatchName(batchIndex);
        return (
            `<span style="color:${color};">Batch: ${batchLabel}<br>Time: ${time.toFixed(3)}<br>Value: ${value.toFixed(3)}` +
            this._episodeTooltipText(name, idx) +
            "</span>"
        );
    }

    setEndIndex(newEndIndex, force = false) {
        if (this.times.length === 0) return; // store not loaded yet (initFromStore pending)
        if (newEndIndex < 0 || newEndIndex >= this.times.length) {
            console.warn(
                "Invalid end index. Must be within the range of time values."
            );
            return;
        }
        if (this.currentEndIndex === newEndIndex && !force) {
            return;
        }
        this.currentEndIndex = newEndIndex;
        this.markerDirty = true;
    }

    setFocusedBatch(batchIndex, force = false) {
        if (batchIndex < 0 || batchIndex >= this.app.batchManager.simBatches) {
            console.warn("Invalid batch index.");
            return;
        }
        if (this.currentFocusedBatch === batchIndex && !force) {
            return;
        }
        this.currentFocusedBatch = batchIndex;

        const activeChart = this.charts.get(this.activeScalar);
        if (!activeChart) {
            console.warn(`No chart found for scalar "${this.activeScalar}".`);
            return;
        }
        this.opacityRenderCallback = () => {
            for (let i = 0; i < this.app.batchManager.simBatches; i++) {
                const opacity =
                    i === batchIndex ? 1 : SCALAR_PLOTTER_CONFIG.inactiveBatchOpacity;
                const baseColor = this.app.batchManager.getColorForBatch(i);
                const rgbaColor = this._hexToRgba(baseColor, opacity);
                // uPlot normalizes series.stroke into a function at series-init
                // time and re-invokes it (`s.stroke(self, si)`) on every draw
                // (see cacheStrokeFill in uPlot.esm.js) -- overwriting it with
                // a raw string here breaks that on the very next redraw
                // ("s.stroke is not a function"). Wrap it back into a function.
                activeChart.series[i + 1].stroke = () => rgbaColor;
            }
        };
    }

    _hexToRgba(hex, opacity) {
        hex = hex.replace("#", "");
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }

    _renderChart() {
        const activeChart = this.charts.get(this.activeScalar);
        if (!activeChart) return;

        const plotDiv = this.plotElements[this.activeScalar];
        if (!this.isExpanded || plotDiv.hidden) {
            return;
        }

        var needRender = false;
        if (this.markerDirty) {
            this.markerDirty = false;
            needRender = true;
        }
        if (this.opacityRenderCallback) {
            this.opacityRenderCallback();
            this.opacityRenderCallback = null;
            needRender = true;
        }

        if (!needRender) return;
        // The data only changes via setData (live append), so the cached
        // paths stay valid; strokes (focus opacity) are re-read on every draw.
        activeChart.redraw(false);
    }

    animate(now) {
        if (now - this.lastRenderTime < this.minRenderDelay) return;
        if (this._appendPending) this._pullAppended();
        this._renderChart();
        this.lastRenderTime = now;
    }

    dispose() {
        for (const chart of this.charts.values()) {
            chart.destroy();
        }
        this.charts.clear();
        this.scalarSeries.clear();
        this.scalarBounds.clear();
        this.scalarColumns.clear();
    }
}
