// Bottom-right, toggleable panel listing every batch's color swatch and name.
// Doubles as a batch picker (click a row to focus it) and a renaming UI (click
// the name to edit it in place); renames are persisted server-side via
// BatchManager.setBatchName so they survive a reload.
export class BatchLegend {
    static cssInjected = false;
    static styleId = "batch-legend-styles";

    constructor(app) {
        this.app = app;
        this.isExpanded = true;
        this.rowElements = new Map();

        this._injectStyles();
        this._setupHTML();
    }

    _injectStyles() {
        if (BatchLegend.cssInjected || document.getElementById(BatchLegend.styleId)) {
            BatchLegend.cssInjected = true;
            return;
        }
        const css = `
        .batch-legend-container {
            width: 220px;
            position: fixed;
            bottom: 1rem;
            right: 1rem;
            background-color: rgba(0, 0, 0, 0.75);
            color: white;
            border-radius: 8px;
            font-family: Arial, sans-serif;
            font-size: 12px;
            z-index: 1000;
        }
        .batch-legend-header {
            display: flex;
            align-items: center;
            padding: 8px 10px;
            cursor: pointer;
            font-weight: bold;
            font-size: 1.1em;
        }
        .batch-legend-header:hover {
            background-color: rgba(255, 255, 255, 0.1);
        }
        .batch-legend-header-icon {
            padding-right: 0.4rem;
            color: #ccc;
        }
        .batch-legend-content {
            display: none;
            padding: 0 8px 8px 8px;
            border-top: 1px solid rgba(255, 255, 255, 0.5);
            max-height: 30vh;
            overflow-y: auto;
        }
        .batch-legend-content.visible {
            display: block;
        }
        .batch-legend-row {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 5px 4px;
            margin-top: 4px;
            border-radius: 4px;
            cursor: pointer;
        }
        .batch-legend-row:hover {
            background-color: rgba(255, 255, 255, 0.1);
        }
        .batch-legend-row.active {
            background-color: rgba(255, 255, 255, 0.18);
            outline: 1px solid rgba(255, 255, 255, 0.6);
        }
        .batch-legend-swatch {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            flex: none;
            border: 1px solid rgba(255, 255, 255, 0.4);
        }
        .batch-legend-index {
            color: #ccc;
            flex: none;
        }
        .batch-legend-name {
            flex: 1;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            background: transparent;
            border: 1px solid transparent;
            color: white;
            font-family: Arial, sans-serif;
            font-size: 1em;
            padding: 1px 3px;
            border-radius: 3px;
        }
        .batch-legend-name:hover {
            border-color: rgba(255, 255, 255, 0.3);
        }
        .batch-legend-name:focus {
            outline: none;
            border-color: white;
            background-color: rgba(255, 255, 255, 0.1);
            cursor: text;
        }
        `;
        const styleElement = document.createElement("style");
        styleElement.id = BatchLegend.styleId;
        styleElement.textContent = css;
        document.head.appendChild(styleElement);
        BatchLegend.cssInjected = true;
    }

    _setupHTML() {
        this.container = document.createElement("div");
        this.container.className = "batch-legend-container";

        this.header = document.createElement("div");
        this.header.className = "batch-legend-header";
        this.icon = document.createElement("span");
        this.icon.className = "batch-legend-header-icon";
        const title = document.createElement("span");
        title.textContent = "Batches";
        this.header.appendChild(this.icon);
        this.header.appendChild(title);
        this.header.addEventListener("click", () => this._toggleDropdown());

        this.content = document.createElement("div");
        this.content.className = "batch-legend-content";

        this._buildRows();
        this._applyExpandedState();

        this.container.appendChild(this.header);
        this.container.appendChild(this.content);
        document.body.appendChild(this.container);
    }

    _buildRows() {
        this.content.innerHTML = "";
        this.rowElements.clear();
        const { batchManager } = this.app;
        for (let i = 0; i < batchManager.simBatches; i++) {
            const row = document.createElement("div");
            row.className = "batch-legend-row";

            const swatch = document.createElement("span");
            swatch.className = "batch-legend-swatch";
            const color = batchManager.getColorForBatch(i);
            swatch.style.backgroundColor =
                typeof color === "string" ? color : `#${color.getHexString()}`;

            const index = document.createElement("span");
            index.className = "batch-legend-index";
            index.textContent = `${i}`;

            const nameInput = document.createElement("input");
            nameInput.type = "text";
            nameInput.className = "batch-legend-name";
            nameInput.value = batchManager.getBatchName(i);
            nameInput.addEventListener("click", (e) => e.stopPropagation());
            nameInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") nameInput.blur();
                e.stopPropagation();
            });
            nameInput.addEventListener("change", () => {
                batchManager.setBatchName(i, nameInput.value);
            });

            row.appendChild(swatch);
            row.appendChild(index);
            row.appendChild(nameInput);
            row.addEventListener("click", () => batchManager.setActiveBatch(i));

            this.content.appendChild(row);
            this.rowElements.set(i, row);
        }
        this.highlightActive();
    }

    highlightActive() {
        const active = this.app.batchManager.currentlyActiveBatch;
        this.rowElements.forEach((row, i) => {
            row.classList.toggle("active", i === active);
        });
    }

    // Re-reads names/colors from BatchManager, e.g. after a rename elsewhere.
    refresh() {
        this._buildRows();
    }

    _toggleDropdown() {
        this.isExpanded = !this.isExpanded;
        this._applyExpandedState();
    }

    _applyExpandedState() {
        this.content.classList.toggle("visible", this.isExpanded);
        this.icon.textContent = this.isExpanded ? "▾" : "▸";
    }

    dispose() {
        if (this.container && this.container.parentElement) {
            this.container.parentElement.removeChild(this.container);
        }
        this.rowElements.clear();
    }
}
