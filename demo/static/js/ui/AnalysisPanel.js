// Shared top-center panel hosting the Scalars plots, the Error Metrics
// comparison and the Terrain profile. Owns the collapsible container and,
// when two or more are present, the mode switcher between them; each panel
// just mounts its content into the section this panel provides.
export class AnalysisPanel {
    constructor(app) {
        this.app = app;
        this.mode = "scalars";
        // In tab order. `instance` is set once the panel is attached.
        this.sections = [
            { key: "scalars", title: "Scalars" },
            { key: "errorMetrics", title: "Error Metrics" },
            { key: "terrain", title: "Terrain" },
        ];

        this.container = document.createElement("details");
        this.container.className = "analysis-container sv-collapsible";
        this.container.addEventListener("toggle", () => this._applyMode());

        const summary = document.createElement("summary");
        summary.className = "analysis-header";
        this.titleEl = document.createElement("span");
        this.titleEl.className = "analysis-header-title";
        this.titleEl.textContent = "Analysis";
        summary.appendChild(this.titleEl);

        this.modeTabBar = document.createElement("div");
        this.modeTabBar.className = "analysis-mode-tab-bar";
        this.modeTabBar.hidden = true;
        this.container.appendChild(summary);
        this.container.appendChild(this.modeTabBar);

        for (const section of this.sections) {
            section.tab = document.createElement("button");
            section.tab.className = "analysis-mode-tab";
            section.tab.textContent = section.title;
            section.tab.hidden = true;
            section.tab.addEventListener("click", () => {
                this.mode = section.key;
                this._applyMode();
            });
            this.modeTabBar.appendChild(section.tab);

            section.el = document.createElement("div");
            section.el.hidden = true;
            this.container.appendChild(section.el);
        }
        document.body.appendChild(this.container);
    }

    attach(key, instance, ...elements) {
        const section = this.sections.find((s) => s.key === key);
        section.instance = instance;
        section.el.append(...elements);
        section.tab.hidden = false;

        const attached = this.sections.filter((s) => s.instance);
        this.modeTabBar.hidden = attached.length < 2;
        if (!attached.some((s) => s.key === this.mode)) this.mode = attached[0].key;
        this.titleEl.textContent = attached.length === 1 ? attached[0].title : "Analysis";
        this._applyMode();
    }

    attachScalarPlotter(p) {
        this.attach("scalars", p, p.tabBar, p.plotArea);
    }

    attachErrorMetrics(p) {
        this.attach("errorMetrics", p, p.content);
    }

    attachTerrainProfile(p) {
        this.attach("terrain", p, p.content);
    }

    _applyMode() {
        for (const section of this.sections) {
            const active = this.mode === section.key;
            section.el.hidden = !active;
            section.tab.classList.toggle("active", active);
            if (section.instance) section.instance.setVisible(this.container.open && active);
        }
    }

    dispose() {
        this.container.remove();
    }
}
