import { FREQ_CONFIG } from "../config.js";
import { isEditableTarget } from "../utils/keyboard.js";

// Top-left collapsible panel listing posed bodies; selecting one shows its
// position/rotation for the active batch, refreshed at FREQ_CONFIG rate.
export class BodyStateWindow {
    constructor(app) {
        this.app = app;
        this.selectedBodies = new Set();
        this.window = null;
        this.batchSelector = null;
        this.header = null;
        this.content = null;
        this.bodyListContainer = null;
        this.detailsContainer = null;
        this.bodyListItems = new Map(); // body name -> list item
        this.detailContainers = new Map(); // body name -> detail container
        this.minRenderDelay = 1000 / FREQ_CONFIG.bodyStateWindow;
        this.lastRenderTime = Number.NEGATIVE_INFINITY;

        this.initWindow();
    }

    initWindow() {
        this.window = document.createElement("details");
        this.window.className = "body-state-window sv-collapsible";
        // model.collapse is the authoring-time hint to start collapsed;
        // viewerDefaults.bodyStatesOpen (applied after construction, see
        // utils/viewerDefaults.js) wins when present.
        this.window.open = this.app.model?.collapse !== true;

        this.header = document.createElement("summary");
        this.header.classList.add("body-state-window-header");
        this.window.appendChild(this.header);

        const title = document.createElement("span");
        title.textContent = "Body states";
        this.header.appendChild(title);

        const batchSize = this.app.batchManager.simBatches;
        if (batchSize > 1) {
            const selectorContainer = document.createElement("div");
            selectorContainer.classList.add("batch-selector-container");

            const label = document.createElement("span");
            label.textContent = "Batch: ";
            label.classList.add("batch-selector-label");
            selectorContainer.appendChild(label);

            const batchSelector = document.createElement("select");
            batchSelector.classList.add("batch-selector");

            for (let i = 0; i < batchSize; i++) {
                const option = document.createElement("option");
                option.value = i;
                option.textContent = `${i}`;
                batchSelector.appendChild(option);
            }

            batchSelector.addEventListener("change", (e) => {
                const batchIndex = parseInt(e.target.value);
                this.app.batchManager.setActiveBatch(batchIndex);
                e.target.blur();
            });

            // A click on the selector would otherwise toggle the panel.
            selectorContainer.addEventListener("click", (e) => e.preventDefault());
            selectorContainer.appendChild(batchSelector);
            this.header.appendChild(selectorContainer);
            this.batchSelector = batchSelector;
        }

        this.content = document.createElement("div");
        this.content.classList.add("body-state-window-content");
        this.window.appendChild(this.content);

        this.bodyListContainer = document.createElement("div");
        this.bodyListContainer.classList.add("body-list-container");
        this.content.appendChild(this.bodyListContainer);

        this.detailsContainer = document.createElement("div");
        this.detailsContainer.classList.add("details-container");
        this.content.appendChild(this.detailsContainer);

        document.body.appendChild(this.window);

        // Space is PlaybackControls' play/pause key; stop the browser from also
        // scrolling or toggling a focused <details> summary.
        this.keydownListener = (event) => {
            if (isEditableTarget(event)) return; // also covers the batch selector
            if (event.code === "Space") event.preventDefault();
        };
        window.addEventListener("keydown", this.keydownListener);

        this.updateBodyList();
    }

    updateBodyList() {
        this.bodyListContainer.innerHTML = "";
        this.bodyListItems.clear();

        const title = document.createElement("div");
        title.textContent = "Bodies:";
        title.classList.add("body-list-title");
        this.bodyListContainer.appendChild(title);

        const list = document.createElement("ul");
        list.classList.add("body-list");

        for (const [name, body] of this.app.bodies) {
            // Listing a static point cloud only offers a permanently-zero
            // Position/Rotation row.
            if (!body.hasPose) continue;
            const item = document.createElement("li");
            item.classList.add("body-list-item");
            item.textContent = name;
            item.dataset.bodyName = name;

            item.addEventListener("click", () => {
                if (this.selectedBodies.has(name)) {
                    this.deselectBody(name);
                } else {
                    this.selectBody(name);
                }
            });

            list.appendChild(item);
            this.bodyListItems.set(name, item);

            this.updateBodyListItemStyle(name);
        }

        this.bodyListContainer.appendChild(list);
        // Nothing to read in a scene with no posed bodies (e.g. only static
        // point clouds); the BatchLegend already covers batch switching.
        this.window.hidden = this.bodyListItems.size === 0;
    }

    selectBody(name) {
        if (!this.selectedBodies.has(name)) {
            this.selectedBodies.add(name);
            const body = this.app.bodies.get(name);
            if (body) {
                const container = this.createBodyDetailContainer(body);
                this.detailsContainer.appendChild(container);
                this.detailContainers.set(name, container);
                this.updateBodyListItemStyle(name);
            }
        }
    }

    deselectBody(name) {
        if (this.selectedBodies.has(name)) {
            this.selectedBodies.delete(name);
            const container = this.detailContainers.get(name);
            if (container) {
                this.detailsContainer.removeChild(container);
                this.detailContainers.delete(name);
            }
            this.updateBodyListItemStyle(name);
        }
    }

    updateBodyListItemStyle(name) {
        const item = this.bodyListItems.get(name);
        if (item) item.classList.toggle("selected", this.selectedBodies.has(name));
    }

    createBodyDetailContainer(body) {
        const container = document.createElement("div");
        container.classList.add("body-detail-container");

        const closeButton = document.createElement("div");
        closeButton.innerHTML = "✕";
        closeButton.classList.add("body-detail-close-button");

        closeButton.addEventListener("click", (e) => {
            e.stopPropagation();
            this.deselectBody(body.name);
        });
        container.appendChild(closeButton);

        const detailsHeader = document.createElement("div");
        detailsHeader.classList.add("body-detail-header");
        container.appendChild(detailsHeader);
        container.header = detailsHeader;

        const table = document.createElement("table");
        table.classList.add("body-detail-table");

        const properties = [
            { key: "positions", label: "Position" },
            { key: "rotations", label: "Rotation" },
        ];

        const valueCells = {};
        for (const prop of properties) {
            if (body.availableAttributes.has(prop.key) || body[prop.key]) {
                const row = table.insertRow();
                const labelCell = row.insertCell(0);
                labelCell.textContent = prop.label;
                const valueCell = row.insertCell(1);
                valueCells[prop.key] = valueCell;
            }
        }

        container.appendChild(table);
        container.valueCells = valueCells;

        this.updateBodyDetailContainer(container, body);
        return container;
    }

    update() {
        for (const [name, container] of this.detailContainers) {
            const body = this.app.bodies.get(name);
            if (body) {
                this.updateBodyDetailContainer(container, body);
            }
        }
    }

    // Rewrites one detail block's header and Position/Rotation cells for the
    // active batch, touching the DOM only when the text actually changed.
    updateBodyDetailContainer(container, body) {
        const batchManager = this.app.batchManager;
        let batchText = "";
        const batchIndex = batchManager.currentlyActiveBatch;
        const batchSize = batchManager.simBatches;
        if (batchSize > 1) {
            batchText = ` (Batch ${batchIndex})`;
        }

        container.header.textContent = `${body.name}${batchText}`;

        for (const [key, cell] of Object.entries(container.valueCells)) {
            var vector = null;
            if (body[key] && body[key][batchIndex]) {
                vector = body[key][batchIndex];
            } else if (body.availableAttributes.has(key)) {
                vector = body.attributeStorage.get(key)[batchIndex];
            }
            if (
                vector &&
                typeof vector.x === "number" &&
                typeof vector.y === "number" &&
                typeof vector.z === "number"
            ) {
                const text = `(${vector.x.toFixed(3)}, ${vector.y.toFixed(3)}, ${vector.z.toFixed(3)})`;
                if (cell.textContent !== text) cell.textContent = text;
            } else {
                if (cell.textContent !== "N/A") cell.textContent = "N/A";
            }
        }
    }

    setSelectedBatch(batchIndex) {
        if (this.batchSelector) {
            this.batchSelector.value = batchIndex;
        }
        this.update();
    }

    dispose() {
        window.removeEventListener("keydown", this.keydownListener);
        if (this.window?.parentNode) {
            this.window.remove();
            this.window = null;
        }
    }

    forceRedraw() {
        this.lastRenderTime = Number.NEGATIVE_INFINITY;
        this.update();
    }

    animate(now) {
        if (!this.window) return;

        if (now - this.lastRenderTime < this.minRenderDelay) return;
        this.lastRenderTime = now;
        this.update();
    }
}
