import uPlot from "../../lib/uPlot.esm.js";
import { FREQ_CONFIG, SCALAR_PLOTTER_CONFIG } from "../config.js";
import { injectStyles } from "../utils/injectStyles.js";

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
        this.resizeObservers = new Map();
        this.scalarSeries = new Map();
        this.scalarBounds = new Map();
        this.fullDataPoints = new Map();
        this.times = [];
        this.indices = [];
        this.seriesRenderCallback = null;
        this.opacityRenderCallback = null;
        this.minRenderDelay = 1000 / FREQ_CONFIG.scalarPlotter;
        this.lastRenderTime = Number.NEGATIVE_INFINITY;
        this.renderTimeout = null; // To manage delayed rendering

        this._injectStyles();
        this._setupHTML();
        this._setupEventListeners();
    }

    _injectStyles() {
        const styleId = "scalar-styles";
        const chartHeightPercentage = 15;
        const css = `
        /* Tab bar */
        .scalar-tab-bar {
            display: flex;
            width: 100%;
            flex-wrap: wrap;
            padding: 0;
            position: sticky;
            top: 0;
            z-index: 1;
        }

        /* Tabs */
        .scalar-tab {
            flex: 1;
            text-align: center;
            padding: 5px 10px; /* Adjusted padding */
            margin-right: 2px; /* Space between tabs */
            cursor: pointer;
            background-color: rgba(0, 0, 0, 1);
            border-radius: 2px 2px 0 0;
            font-size: 1.0em;
            color: white;
            transition: background-color 0.2s ease, color 0.2s ease;
            position: relative;
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-bottom: 1px solid white;
            margin-bottom: -1px;
            font-weight: bold;
            white-space: nowrap; /* Prevent wrapping */
            overflow: hidden; /* Hide overflow */
            text-overflow: ellipsis; /* Add ellipsis if text too long */
        }
        .scalar-tab:first-child {
            margin-left: 0;
            border-left: none;
        }
        .scalar-tab:last-child {
            margin-right: 0;
            border-right: none;
        }
        .scalar-tab.active {
            border: 1px solid white;
            border-bottom: 1px solid rgba(0, 0, 0, 1);
        }
        .scalar-tab.active:hover {
            background-color: rgba(0, 0, 0, 1);
        }
        .scalar-tab.active:first-child {
            border-left: none;
        }
        .scalar-tab.active:last-child {
            border-right: none;
        }

        /* Plot area */
        .scalar-plot-area {
            width: 100%;
            height: ${chartHeightPercentage}vh;
          }

        .uplot-plot-div {
            border-top: 1px solid white;
            width: 100%;
            height: 99%;
            display: none;
            background-color: rgba(0, 0, 0, 1);
            cursor: pointer;
        }
        .uplot-plot-div.visible {
            display: block;
        }
        .uplot-plot-div .uplot,
        .uplot-plot-div .u-wrap {
            width: 100%;
            height: 100%;
        }
        .uplot-plot-div .u-legend {
            display: none;
        }
    `;
        injectStyles(styleId, css);
    }

    _setupHTML() {
        this.tabBar = document.createElement("div");
        this.tabBar.className = "scalar-tab-bar";

        this.plotArea = document.createElement("div");
        this.plotArea.className = "scalar-plot-area";

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
            plotDiv.className = "uplot-plot-div";
            plotDiv.dataset.scalarName = name;
            if (index === 0) plotDiv.classList.add("visible");
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

    // Called by AnalysisPanel when this panel becomes/stops being the visible section.
    setVisible(visible) {
        if (this.isExpanded === visible) return;
        this.isExpanded = visible;

        if (this.isExpanded && this.activeScalar) {
            this._resizeChart(this.activeScalar);
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
        if (oldPlot) oldPlot.classList.remove("visible");

        const newTab = this.tabElements[newScalarName];
        const newPlot = this.plotElements[newScalarName];
        if (newTab) newTab.classList.add("active");
        if (newPlot) newPlot.classList.add("visible");

        this.activeScalar = newScalarName;
        this._resizeChart(this.activeScalar);
        this.setEndIndex(this.currentEndIndex, true);
        this.setFocusedBatch(this.currentFocusedBatch, true);
    }

    initFromStates(states) {
        this.times = [];
        const batchSize = this.app.batchManager.simBatches;
        this.indices = [...Array(batchSize).keys()];
        for (const scalarName of this.scalarNames) {
            this.scalarBounds.set(scalarName, [Number.MAX_VALUE, Number.MIN_VALUE]);
            this.scalarSeries.set(
                scalarName,
                new Array(batchSize).fill().map(() => [])
            );
        }
        for (const state of states) {
            for (const scalarName of this.scalarNames) {
                const scalarValues = state[scalarName];
                if (scalarValues === undefined) {
                    throw new Error(`Scalar "${scalarName}" not found in state.`);
                }
                var [min, max] = this.scalarBounds.get(scalarName);
                for (let i = 0; i < batchSize; i++) {
                    const scalarValue = scalarValues[i];
                    if (scalarValue === undefined) {
                        throw new Error(
                            `Scalar "${scalarName}" not found in state at index ${i}.`
                        );
                    }
                    // Store as plain {x, y} points; sliced into uPlot's columnar
                    // format on render.
                    this.scalarSeries.get(scalarName)[i].push({ x: state.time, y: scalarValue });
                    min = Math.min(min, scalarValue);
                    max = Math.max(max, scalarValue);
                }
                this.scalarBounds.set(scalarName, [min, max]);
            }
            this.times.push(state.time);
        }

        for (const scalarName of this.scalarNames) {
            console.log(
                "Scalar",
                scalarName,
                " has bounds",
                this.scalarBounds.get(scalarName)
            );
        }

        this._initializePlots();
        if (this.isExpanded) {
            this.setEndIndex(this.currentEndIndex, true);
            this.setFocusedBatch(this.currentFocusedBatch, true);
        }
    }

    getChartInterval(min, max) {
        const diff = max - min;
        if (diff === 0)
            return Math.max(
                Math.abs(max) / SCALAR_PLOTTER_CONFIG.stepsPerYAxis,
                1e-3
            );
        return diff / SCALAR_PLOTTER_CONFIG.stepsPerYAxis;
    }

    // Finds the batch series whose y-value at the clicked x-index is closest
    // to the clicked y-pixel, so a click near a particular line focuses that
    // batch.
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

            const rect = plotDiv.getBoundingClientRect();
            const chart = new uPlot(
                {
                    width: Math.max(rect.width, 1),
                    height: Math.max(rect.height, 1),
                    padding: [8, 8, 0, 8],
                    series,
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
                            incrs: [this.getChartInterval(min, max)],
                        },
                    ],
                    legend: { show: false },
                    cursor: {
                        drag: { x: false, y: false },
                        points: { show: false },
                    },
                    hooks: {
                        setCursor: [
                            (u) => {
                                this._updateTooltip(u, name);
                            },
                        ],
                    },
                },
                [[], ...new Array(this.app.batchManager.simBatches).fill([])],
                plotDiv
            );

            chart.over.addEventListener("click", (e) => {
                const idx = chart.cursor.idx;
                if (idx === null || idx === undefined) return;
                const xVal = chart.data[0][idx];
                const yVal = chart.posToVal(e.offsetY, "y");
                const batchIndex = this._closestSeriesAtIndex(chart, idx, yVal);
                if (batchIndex >= 0) {
                    this.app.batchManager.setActiveBatch(batchIndex);
                }
                if (xVal !== undefined && xVal !== null && this.app.animationController) {
                    this.app.animationController.goToTime(xVal);
                }
            });

            this._createTooltip(plotDiv);

            this.charts.set(name, chart);

            const resizeObserver = new ResizeObserver(() => this._resizeChart(name));
            resizeObserver.observe(plotDiv);
            this.resizeObservers.set(name, resizeObserver);
        });
    }

    _createTooltip(plotDiv) {
        const tooltip = document.createElement("div");
        tooltip.style.cssText =
            "position:absolute;pointer-events:none;display:none;" +
            "background:rgba(20,20,20,0.9);border:1px solid rgba(255,255,255,0.3);" +
            "border-radius:3px;padding:4px 6px;font-family:Arial;font-size:11px;" +
            "color:white;white-space:nowrap;z-index:10;";
        plotDiv.style.position = "relative";
        plotDiv.appendChild(tooltip);
        plotDiv._tooltip = tooltip;
    }

    _updateTooltip(u, name) {
        const plotDiv = this.plotElements[name];
        const tooltip = plotDiv && plotDiv._tooltip;
        if (!tooltip) return;

        const idx = u.cursor.idx;
        if (idx === null || idx === undefined || u.cursor.left < 0) {
            tooltip.style.display = "none";
            return;
        }

        const yVal = u.posToVal(u.cursor.top, "y");
        const batchIndex = this._closestSeriesAtIndex(u, idx, yVal);
        if (batchIndex < 0) {
            tooltip.style.display = "none";
            return;
        }

        const time = u.data[0][idx];
        const value = u.data[batchIndex + 1][idx];
        if (value === null || value === undefined) {
            tooltip.style.display = "none";
            return;
        }
        const batchLabel = this.app.batchManager.getBatchName(batchIndex);
        const color = this.app.batchManager.getColorForBatch(batchIndex);

        tooltip.style.color = color;
        tooltip.innerHTML = `Batch: ${batchLabel}<br>Time: ${time.toFixed(3)}<br>Value: ${value.toFixed(3)}`;
        tooltip.style.display = "block";

        const left = u.cursor.left + 12;
        const top = u.cursor.top + 12;
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
    }

    _resizeChart(name) {
        const chart = this.charts.get(name);
        const plotDiv = this.plotElements[name];
        if (!chart || !plotDiv) return;
        const rect = plotDiv.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        chart.setSize({ width: rect.width, height: rect.height });
    }

    setEndIndex(newEndIndex, force = false) {
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
        const activeChart = this.charts.get(this.activeScalar);
        if (!activeChart) {
            console.warn(`No chart found for scalar "${this.activeScalar}".`);
            return;
        }

        const scalarData = this.scalarSeries.get(this.activeScalar);
        if (!scalarData) {
            console.warn(`No data points found for scalar "${this.activeScalar}".`);
            return;
        }

        this.seriesRenderCallback = () => {
            const numPoints = this.currentEndIndex + 1;
            const xValues = this.times.slice(0, numPoints);
            const data = [xValues];
            for (let i = 0; i < this.app.batchManager.simBatches; i++) {
                data.push(scalarData[i].slice(0, numPoints).map((p) => p.y));
            }
            activeChart.setData(data, false);
        };
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
                activeChart.series[i + 1].stroke = rgbaColor;
                activeChart.series[i + 1]._stroke = rgbaColor;
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
        if (!this.isExpanded || !plotDiv.classList.contains("visible")) {
            return;
        }

        var needRender = false;
        if (this.seriesRenderCallback) {
            this.seriesRenderCallback();
            this.seriesRenderCallback = null;
            needRender = true;
        }
        if (this.opacityRenderCallback) {
            this.opacityRenderCallback();
            this.opacityRenderCallback = null;
            needRender = true;
        }

        if (!needRender) return;
        activeChart.redraw(false, true);
    }

    animate(now) {
        if (now - this.lastRenderTime < this.minRenderDelay) return;
        this._renderChart();
        this.lastRenderTime = now;
    }

    dispose() {
        for (const chart of this.charts.values()) {
            chart.destroy();
        }
        for (const observer of this.resizeObservers.values()) {
            observer.disconnect();
        }
        this.charts.clear();
        this.resizeObservers.clear();
        this.scalarSeries.clear();
        this.scalarBounds.clear();
    }
}
