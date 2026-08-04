export class Legend {
    constructor(app) {
        this.app = app;
        this.container = this.createContainer("terrain-legend", "20px");
        this.pointContainer = this.createContainer("point-legend", "90px");
        document.body.appendChild(this.container);
        document.body.appendChild(this.pointContainer);
        this.update();
    }

    createContainer(id, bottomOffset) {
        const container = document.createElement("div");
        container.id = id;
        container.style.position = "absolute";
        container.style.bottom = bottomOffset;
        container.style.left = "20px";
        container.style.backgroundColor = "rgba(0, 0, 0, 0.7)";
        container.style.color = "white";
        container.style.padding = "10px";
        container.style.borderRadius = "5px";
        container.style.fontFamily = "sans-serif";
        container.style.fontSize = "12px";
        container.style.pointerEvents = "none";
        container.style.zIndex = "1000";
        container.style.display = "flex";
        container.style.flexDirection = "column";
        container.style.minWidth = "150px";
        container.style.border = "1px solid rgba(255, 255, 255, 0.2)";
        return container;
    }

    update() {
        this.#updateTerrainLegend();
        this.#updatePointLegend();
    }

    #updateTerrainLegend() {
        if (!this.app.terrain) {
            this.container.style.display = "none";
            return;
        }

        const mode = this.app.uiState.terrainColorMode || "height";
        const cmapName =
            mode === "diff" || mode === "features"
                ? "coolwarm"
                : this.app.uiState.terrainColorMap || "viridis";

        let minVal, maxVal, unit, title;

        if (mode === "height") {
            minVal = this.app.terrain.bounds.minZ;
            maxVal = this.app.terrain.bounds.maxZ;
            unit = "m";
            title = "Height";
        } else if (mode === "diff") {
            const layer =
                this.app.uiState.terrainDiffLayer ||
                this.app.terrain.getAvailableDiffLayers()[0];
            const batchA = this.app.uiState.terrainDiffBatchA ?? 0;
            const batchB =
                this.app.uiState.terrainDiffBatchB ??
                Math.min(1, this.app.batchManager.simBatches - 1);
            const maxAbsDelta = this.app.terrain.getDiffMaxAbsDelta();
            minVal = -maxAbsDelta;
            maxVal = maxAbsDelta;
            unit = layer === "height" ? "m" : "";
            const layerTitle = layer.charAt(0).toUpperCase() + layer.slice(1);
            title = `Δ${layerTitle} (batch ${batchB} − batch ${batchA})`;
        } else if (mode === "features") {
            // Cosine similarity is always in [-1, 1], independent of the
            // underlying embedding's own scale (unlike diff, there's no
            // data-driven range to compute).
            minVal = -1;
            maxVal = 1;
            unit = "";
            title = "Cosine similarity to clicked cell";
        } else if (this.app.terrain.properties.has(mode)) {
            const propBounds = this.app.terrain.propertyBounds.get(mode) || {};
            minVal = propBounds.min ?? 0.0;
            maxVal = propBounds.max ?? 1.0;
            unit = "";
            title = mode.charAt(0).toUpperCase() + mode.slice(1);
        }

        // Large-magnitude properties (e.g. stiffness, typically ~1e5) read
        // better without decimals; small ones (e.g. friction, typically
        // ~[0, 1]) need them -- this heuristic works for any named property,
        // not just a hardcoded one.
        const decimals = Math.abs(maxVal) > 1000 ? 0 : 2;

        this.container.style.display = "flex";
        this.#renderGradient(this.container, title, unit, minVal, maxVal, decimals, cmapName);
    }

    // Shown whenever at least one body is currently colored by similarity to
    // a clicked point (Body.js's selectedPointIndex, set by
    // recolorBySimilarity / cleared by resetPointColors) -- otherwise a
    // click recolors the whole point cloud with no visible indication of
    // what the colors now mean, and no way to read a value off them.
    #updatePointLegend() {
        const anySimilarity =
            this.app.bodies &&
            [...this.app.bodies.values()].some((body) => body.selectedPointIndex != null);
        if (!anySimilarity || !this.app.terrain) {
            this.pointContainer.style.display = "none";
            return;
        }
        this.pointContainer.style.display = "flex";
        // Fixed coolwarm/[-1,1], matching Body.recolorBySimilarity's own
        // hardcoded colormap and cosine-similarity range.
        this.#renderGradient(
            this.pointContainer,
            "Cosine similarity to clicked point",
            "",
            -1,
            1,
            2,
            "coolwarm"
        );
    }

    #renderGradient(container, title, unit, minVal, maxVal, decimals, cmapName) {
        container.innerHTML = `
            <div style="font-weight: bold; margin-bottom: 5px; text-align: center;">${title} ${unit ? `(${unit})` : ""}</div>
            <div class="legend-gradient" style="height: 20px; width: 100%; margin-bottom: 5px; border: 1px solid white;"></div>
            <div style="display: flex; justify-content: space-between;">
                <span>${minVal.toFixed(decimals)}</span>
                <span>${maxVal.toFixed(decimals)}</span>
            </div>
        `;

        const gradientDiv = container.querySelector(".legend-gradient");
        const callableColormap = this.app.terrain.getCallableFromColorMapName(cmapName);

        // Generate CSS gradient
        const steps = 10;
        const colors = [];
        for (let i = 0; i <= steps; i++) {
            const color = callableColormap(i / steps);
            colors.push(`rgb(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)})`);
        }
        gradientDiv.style.background = `linear-gradient(to right, ${colors.join(", ")})`;
    }

    dispose() {
        if (this.container && this.container.parentElement) {
            this.container.parentElement.removeChild(this.container);
        }
        if (this.pointContainer && this.pointContainer.parentElement) {
            this.pointContainer.parentElement.removeChild(this.pointContainer);
        }
    }
}
