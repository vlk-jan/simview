export class Legend {
    constructor(app) {
        this.app = app;
        this.container = this.createContainer();
        document.body.appendChild(this.container);
        this.update();
    }

    createContainer() {
        const container = document.createElement("div");
        container.id = "terrain-legend";
        container.style.position = "absolute";
        container.style.bottom = "20px";
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
        if (!this.app.terrain) {
            this.container.style.display = "none";
            return;
        }

        this.container.style.display = "flex";
        const mode = this.app.uiState.terrainColorMode || "height";
        const cmapName = this.app.uiState.terrainColorMap || "viridis";

        let minVal, maxVal, unit, title;

        if (mode === "height") {
            minVal = this.app.terrain.bounds.minZ;
            maxVal = this.app.terrain.bounds.maxZ;
            unit = "m";
            title = "Height";
        } else if (mode === "friction") {
            minVal = 0.0;
            maxVal = 1.0;
            unit = "";
            title = "Friction";
        } else if (mode === "stiffness") {
            minVal = 0.0;
            maxVal = 500000.0;
            unit = "N/m";
            title = "Stiffness";
        }

        this.container.innerHTML = `
            <div style="font-weight: bold; margin-bottom: 5px; text-align: center;">${title} ${unit ? `(${unit})` : ""}</div>
            <div id="legend-gradient" style="height: 20px; width: 100%; margin-bottom: 5px; border: 1px solid white;"></div>
            <div style="display: flex; justify-content: space-between;">
                <span>${minVal.toFixed(mode === "stiffness" ? 0 : 2)}</span>
                <span>${maxVal.toFixed(mode === "stiffness" ? 0 : 2)}</span>
            </div>
        `;

        const gradientDiv = this.container.querySelector("#legend-gradient");
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
    }
}
