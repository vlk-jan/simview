// Bottom-right, toggleable panel listing every batch's color swatch and name.
// Doubles as a batch picker (click a row to focus it) and a renaming UI (click
// the name to edit it in place); renames are persisted server-side via
// BatchManager.setBatchName so they survive a reload.
export class BatchLegend {
    constructor(app) {
        this.app = app;
        this.isExpanded = true;
        this.rowElements = new Map();

        this._setupHTML();
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
