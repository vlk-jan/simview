import { FREQ_CONFIG } from "../config.js";

export class BodyStateWindow {
    constructor(app) {
        this.app = app;
        this.selectedBodies = new Set();
        this.window = null;
        this.batchSelector = null;
        this.header = null; // Keep track of header element
        this.content = null;
        this.bodyListContainer = null;
        this.detailsContainer = null;
        this.bodyListItems = new Map(); // Map body name -> list item element
        this.detailContainers = new Map(); // Map body name -> detail container element
        this.minRenderDelay = 1000 / FREQ_CONFIG.bodyStateWindow; // 60 FPS
        this.lastRenderTime = Number.NEGATIVE_INFINITY;

        this.initWindow();
    }

    initWindow() {
        // --- Window setup ---
        this.window = document.createElement("div");
        this.window.classList.add("body-state-window"); // Use CSS class

        // --- Header setup ---
        this.header = document.createElement("div");
        this.header.classList.add("body-state-window-header"); // Use CSS class
        this.header.style.cursor = "pointer";
        this.header.addEventListener("click", () => this.toggleCollapse());
        this.window.appendChild(this.header);

        const titleGroup = document.createElement("div"); // Group title and toggle
        titleGroup.style.display = "flex";
        titleGroup.style.alignItems = "center";
        this.header.appendChild(titleGroup);

        this.toggleIcon = document.createElement("span");
        this.toggleIcon.classList.add("body-state-window-toggle-icon");
        this.toggleIcon.textContent = "▾"; // Default state is expanded
        titleGroup.appendChild(this.toggleIcon);

        const title = document.createElement("span");
        title.textContent = "Body states";
        titleGroup.appendChild(title);

        // --- Batch Selector (if needed) ---
        if (this.app.batchManager && this.app.batchManager.getSimBatches) {
            const batchSize = this.app.batchManager.getSimBatches();
            if (batchSize > 1) {
                const selectorContainer = document.createElement("div");
                selectorContainer.classList.add("batch-selector-container"); // Use CSS class

                const label = document.createElement("span");
                label.textContent = "Batch: ";
                label.classList.add("batch-selector-label"); // Use CSS class
                selectorContainer.appendChild(label);

                const batchSelector = document.createElement("select");
                batchSelector.classList.add("batch-selector"); // Use CSS class

                for (let i = 0; i < batchSize; i++) {
                    const option = document.createElement("option");
                    option.value = i;
                    option.textContent = `${i}`;
                    batchSelector.appendChild(option);
                }

                batchSelector.addEventListener("change", (e) => {
                    const batchIndex = parseInt(e.target.value);
                    this.app.batchManager.setActiveBatch(batchIndex);
                    e.target.blur(); // Remove focus from the selector
                });

                selectorContainer.addEventListener("click", (e) => e.stopPropagation());
                selectorContainer.appendChild(batchSelector);
                this.header.appendChild(selectorContainer); // Append to header
                this.batchSelector = batchSelector;
            }
        }

        // --- Content Area (for scrolling) ---
        this.content = document.createElement("div");
        this.content.classList.add("body-state-window-content"); // Use CSS class for scrolling
        this.window.appendChild(this.content);

        // --- Body List and Details Containers (inside the content area) ---
        this.bodyListContainer = document.createElement("div");
        this.bodyListContainer.classList.add("body-list-container"); // Use CSS class
        this.content.appendChild(this.bodyListContainer);

        this.detailsContainer = document.createElement("div");
        this.detailsContainer.classList.add("details-container"); // Use CSS class
        this.content.appendChild(this.detailsContainer);

        document.body.appendChild(this.window);

        // --- Event Listener (unchanged) ---
        window.addEventListener("keydown", (event) => {
            if (event.code === "Space") {
                const activeElement = document.activeElement;
                if (activeElement === this.batchSelector) {
                    return;
                }
                event.preventDefault();
            }
        });

        // Initialize body list once
        this.updateBodyList();
    }

    toggleCollapse() {
        if (!this.window) return;
        const isCollapsed = this.window.classList.toggle("collapsed");
        this.toggleIcon.textContent = isCollapsed ? "▸" : "▾";
    }

    updateBodyList() {
        this.bodyListContainer.innerHTML = ""; // Clear previous content
        this.bodyListItems.clear();

        const title = document.createElement("div");
        title.textContent = "Bodies:";
        title.classList.add("body-list-title"); // Use CSS class
        this.bodyListContainer.appendChild(title);

        const list = document.createElement("ul");
        list.classList.add("body-list"); // Use CSS class

        for (const [name, body] of this.app.bodies) {
            // A point cloud with no per-frame data is a static prop, not a
            // body with a pose worth reading -- listing it only offers a
            // permanently-zero Position/Rotation row. One that does move
            // (validStates > 0) stays listed like any other body.
            if (body.isPointCloud && !(body.validStates > 0)) continue;
            const item = document.createElement("li");
            item.classList.add("body-list-item"); // Use CSS class
            item.textContent = name;
            item.dataset.bodyName = name; // Store name for easier access if needed

            // Add click handler for selection toggle
            item.addEventListener("click", () => {
                // Use arrow function for concise 'this'
                if (this.selectedBodies.has(name)) {
                    this.deselectBody(name);
                } else {
                    this.selectBody(name);
                }
            });

            list.appendChild(item);
            this.bodyListItems.set(name, item);

            // Initial style update (if it might be pre-selected somehow)
            this.updateBodyListItemStyle(name);
        }

        this.bodyListContainer.appendChild(list);
    }

    selectBody(name) {
        if (!this.selectedBodies.has(name)) {
            this.selectedBodies.add(name);
            const body = this.app.bodies.get(name);
            if (body) {
                const container = this.createBodyDetailContainer(body);
                this.detailsContainer.appendChild(container);
                this.detailContainers.set(name, container);
                this.updateBodyListItemStyle(name); // Update style via class
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
            this.updateBodyListItemStyle(name); // Update style via class
        }
    }

    updateBodyListItemStyle(name) {
        const item = this.bodyListItems.get(name);
        if (item) {
            // Toggle 'selected' class based on the set
            if (this.selectedBodies.has(name)) {
                item.classList.add("selected");
            } else {
                item.classList.remove("selected");
            }
            // Hover styles are now handled purely by CSS :hover pseudo-class
        }
    }

    createBodyDetailContainer(body) {
        const container = document.createElement("div");
        container.classList.add("body-detail-container"); // Use CSS class

        // Close button
        const closeButton = document.createElement("div");
        closeButton.innerHTML = "✕"; // Keep content
        closeButton.classList.add("body-detail-close-button"); // Use CSS class
        // Hover effect is handled by CSS

        closeButton.addEventListener("click", (e) => {
            e.stopPropagation(); // Prevent triggering other clicks
            this.deselectBody(body.name);
        });
        container.appendChild(closeButton);

        // Details header
        const detailsHeader = document.createElement("div");
        detailsHeader.classList.add("body-detail-header"); // Use CSS class
        container.appendChild(detailsHeader);
        container.header = detailsHeader; // Keep reference for updates

        // Details table
        const table = document.createElement("table");
        table.classList.add("body-detail-table"); // Use CSS class

        const properties = [
            { key: "positions", label: "Position" },
            { key: "rotations", label: "Rotation" },
            // { key: "linearVelocity", label: "Velocity" }, // Abbreviate slightly if needed
            // { key: "angularVelocity", label: "Ang. Vel." },
            // { key: "linearForce", label: "Force" },
            // { key: "torque", label: "Torque" },
        ];

        const valueCells = {}; // Keep reference for updates
        for (const prop of properties) {
            if (body.availableAttributes.has(prop.key) || body[prop.key]) {
                const row = table.insertRow();
                const labelCell = row.insertCell(0);
                labelCell.textContent = prop.label;
                // Styling handled by CSS '.body-detail-table td:first-child'
                const valueCell = row.insertCell(1);
                // Styling handled by CSS '.body-detail-table td:last-child'
                valueCells[prop.key] = valueCell; // Store reference to the cell
            }
        }

        container.appendChild(table);
        container.valueCells = valueCells; // Attach value cell references to the container

        // Initial update of content
        this.updateBodyDetailContainer(container, body);
        return container;
    }

    // --- update, updateBodyDetailContainer, setSelectedBatch, show, hide, dispose, forceRedraw, animate ---
    // These methods should remain largely unchanged as they deal with data logic,
    // not the initial setup and styling which we've refactored.

    update() {
        // Only update existing detail containers
        for (const [name, container] of this.detailContainers) {
            const body = this.app.bodies.get(name);
            if (body) {
                this.updateBodyDetailContainer(container, body);
            }
        }
    }

    updateBodyDetailContainer(container, body) {
        // Check if batchManager exists and has the required properties/methods
        const batchManager = this.app.batchManager;
        let batchText = "";
        const batchIndex = batchManager.currentlyActiveBatch;
        const batchSize = batchManager.getSimBatches();
        if (batchSize > 1) {
            batchText = ` (Batch ${batchIndex})`;
        }

        container.header.textContent = `${body.name}${batchText}`;

        for (const [key, cell] of Object.entries(container.valueCells)) {
            // Ensure the property and the specific batch index exist before accessing
            var vector = null;
            if (body[key] && body[key][batchIndex]) {
                vector = body[key][batchIndex];
            } else if (body.availableAttributes.has(key)) {
                vector = body.attributeStorage.get(key)[batchIndex];
            }
            // Check if vector has x, y, z properties before calling toFixed
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
        this.update(); // Update displayed details for the new batch
    }

    show() {
        if (this.window) {
            this.window.style.display = "flex"; // Use flex since the class uses it
        }
    }

    hide() {
        if (this.window) {
            this.window.style.display = "none";
        }
    }

    dispose() {
        if (this.window && this.window.parentNode) {
            this.window.parentNode.removeChild(this.window);
            this.window = null; // Clear reference
            // Could also remove the keydown listener here if necessary
        }
    }

    forceRedraw() {
        this.lastRenderTime = Number.NEGATIVE_INFINITY;
        this.update();
    }

    animate(now) {
        if (!this.window || this.window.style.display === "none") return; // Don't update if hidden

        if (now - this.lastRenderTime < this.minRenderDelay) return;
        this.lastRenderTime = now;
        this.update();
    }
}
