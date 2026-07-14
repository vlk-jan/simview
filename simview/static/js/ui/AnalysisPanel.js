import { injectStyles } from "../utils/injectStyles.js";

// Shared top-center panel hosting the Scalars plots and the Error Metrics
// comparison. Owns the collapsible container and, when both are present, the
// mode switcher between them; ScalarPlotter and ErrorMetrics just mount their
// content into the sections this panel provides.
export class AnalysisPanel {
    constructor(app) {
        this.app = app;
        this.isExpanded = false;
        this.mode = "scalars";
        this.scalarPlotter = null;
        this.errorMetrics = null;
        this.modeTabElements = {};

        this._injectStyles();
        this._setupHTML();
    }

    _injectStyles() {
        const styleId = "analysis-panel-styles";
        const containerWidthPercentage = 40;
        const css = `
        .analysis-container {
            width: ${containerWidthPercentage}%;
            position: absolute;
            top: 10px;
            left: 50%;
            transform: translateX(-50%);
            background-color: rgba(0, 0, 0, 0.7);
            color: white;
            border-radius: 5px;
            font-family: Arial, sans-serif;
            font-size: 12px;
            z-index: 1000;
        }

        .analysis-header {
            display: flex;
            justify-content: flex-start;
            background-color: transparent;
            align-items: center;
            width: 100%;
            padding: 7px 10px;
            color: white;
            cursor: pointer;
            border-radius: 5px 5px 0 0;
            transition: background-color 0.2s ease;
            box-sizing: border-box;
        }
        .analysis-header:hover {
            background-color: rgba(255, 255, 255, 0.1);
        }
        .analysis-header-title {
            font-weight: bold;
            font-size: 1.1em;
        }
        .analysis-header-icon {
            display: inline-block;
            user-select: none;
            padding-right: 0.4rem;
            color: #ccc;
        }

        .analysis-content {
            border-radius: 0 0 5px 5px;
            display: none;
            box-sizing: border-box;
        }
        .analysis-content.visible {
            display: block;
        }

        .analysis-mode-tab-bar {
            display: none;
            width: 100%;
        }
        .analysis-mode-tab-bar.visible {
            display: flex;
        }
        .analysis-mode-tab {
            flex: 1;
            text-align: center;
            padding: 6px 10px;
            cursor: pointer;
            background-color: rgba(255, 255, 255, 0.05);
            font-size: 1.0em;
            color: #ccc;
            border: none;
            border-bottom: 1px solid rgba(255, 255, 255, 0.3);
            font-weight: bold;
        }
        .analysis-mode-tab:hover {
            background-color: rgba(255, 255, 255, 0.12);
        }
        .analysis-mode-tab.active {
            color: white;
            background-color: rgba(255, 255, 255, 0.18);
            border-bottom: 1px solid white;
        }

        .analysis-section {
            display: none;
        }
        .analysis-section.visible {
            display: block;
        }
        `;
        injectStyles(styleId, css);
    }

    _setupHTML() {
        this.container = document.createElement("div");
        this.container.className = "analysis-container";

        this.header = document.createElement("div");
        this.header.className = "analysis-header";
        this.icon = document.createElement("span");
        this.icon.className = "analysis-header-icon";
        this.icon.textContent = "▸";
        this.titleEl = document.createElement("span");
        this.titleEl.className = "analysis-header-title";
        this.titleEl.textContent = "Analysis";
        this.header.appendChild(this.icon);
        this.header.appendChild(this.titleEl);
        this.header.addEventListener("click", () => this._toggleDropdown());

        this.content = document.createElement("div");
        this.content.className = "analysis-content";

        this.modeTabBar = document.createElement("div");
        this.modeTabBar.className = "analysis-mode-tab-bar";
        this.modeTabElements.scalars = this._addModeTab("Scalars", "scalars");
        this.modeTabElements.errorMetrics = this._addModeTab("Error Metrics", "errorMetrics");

        this.scalarsSection = document.createElement("div");
        this.scalarsSection.className = "analysis-section";
        this.errorMetricsSection = document.createElement("div");
        this.errorMetricsSection.className = "analysis-section";

        this.content.appendChild(this.modeTabBar);
        this.content.appendChild(this.scalarsSection);
        this.content.appendChild(this.errorMetricsSection);
        this.container.appendChild(this.header);
        this.container.appendChild(this.content);
        document.body.appendChild(this.container);
    }

    _addModeTab(label, mode) {
        const tab = document.createElement("button");
        tab.className = "analysis-mode-tab";
        tab.textContent = label;
        tab.addEventListener("click", () => this._switchMode(mode));
        this.modeTabBar.appendChild(tab);
        return tab;
    }

    attachScalarPlotter(scalarPlotter) {
        this.scalarPlotter = scalarPlotter;
        this.scalarsSection.appendChild(scalarPlotter.tabBar);
        this.scalarsSection.appendChild(scalarPlotter.plotArea);
        this._refreshLayout();
    }

    attachErrorMetrics(errorMetrics) {
        this.errorMetrics = errorMetrics;
        this.errorMetricsSection.appendChild(errorMetrics.content);
        this._refreshLayout();
    }

    _refreshLayout() {
        const hasScalars = !!this.scalarPlotter;
        const hasErrorMetrics = !!this.errorMetrics;
        const showModeBar = hasScalars && hasErrorMetrics;
        this.modeTabBar.classList.toggle("visible", showModeBar);

        if (!hasScalars) this.mode = "errorMetrics";
        else if (!hasErrorMetrics) this.mode = "scalars";

        this.titleEl.textContent = showModeBar
            ? "Analysis"
            : hasErrorMetrics
              ? "Error Metrics"
              : "Scalars";

        this._applyMode();
    }

    _applyMode() {
        this.scalarsSection.classList.toggle("visible", this.mode === "scalars");
        this.errorMetricsSection.classList.toggle(
            "visible",
            this.mode === "errorMetrics"
        );
        if (this.modeTabElements.scalars) {
            this.modeTabElements.scalars.classList.toggle(
                "active",
                this.mode === "scalars"
            );
        }
        if (this.modeTabElements.errorMetrics) {
            this.modeTabElements.errorMetrics.classList.toggle(
                "active",
                this.mode === "errorMetrics"
            );
        }
        if (this.scalarPlotter) {
            this.scalarPlotter.setVisible(this.isExpanded && this.mode === "scalars");
        }
        if (this.errorMetrics) {
            this.errorMetrics.setVisible(this.isExpanded && this.mode === "errorMetrics");
        }
    }

    _switchMode(mode) {
        if (mode === this.mode) return;
        this.mode = mode;
        this._applyMode();
    }

    _toggleDropdown() {
        this.isExpanded = !this.isExpanded;
        this.content.classList.toggle("visible", this.isExpanded);
        this.icon.textContent = this.isExpanded ? "▾" : "▸";
        this._applyMode();
    }

    dispose() {
        if (this.container && this.container.parentElement) {
            this.container.parentElement.removeChild(this.container);
        }
    }
}
