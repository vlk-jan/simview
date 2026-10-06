// Pure helpers for the model's optional `viewerDefaults` block (see
// docs/dev/json-format.md): initial UI state declared at authoring time.

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Root-element selector per hideable panel. Hiding is done with one injected
// stylesheet (not per-element) because some panels, e.g. the playback bar,
// are only built after the states load.
export const PANEL_SELECTORS = {
    playback: ".sv-playback",
    analysis: ".analysis-container",
    legend: ".sv-legend",
    batchLegend: ".batch-legend-container",
    bodyStates: ".body-state-window",
    controls: ".lil-gui.root",
};

// Deep-merges `ui` into a copy of `uiState`, skipping (with a console.warn)
// keys `uiState` doesn't have. Never mutates its arguments.
export function mergeUiDefaults(uiState, ui) {
    const out = structuredClone(uiState);
    if (!isPlainObject(ui)) return out;
    const walk = (target, src, path) => {
        for (const [key, value] of Object.entries(src)) {
            if (!(key in target)) {
                console.warn(`viewerDefaults.ui: unknown key "${path}${key}" ignored`);
            } else if (isPlainObject(target[key]) && isPlainObject(value)) {
                walk(target[key], value, `${path}${key}.`);
            } else {
                target[key] = value;
            }
        }
    };
    walk(out, ui, "");
    return out;
}

// CSS hiding every panel set to `false` in `panels`; "" when none.
export function panelHideCss(panels) {
    if (!isPlainObject(panels)) return "";
    return Object.entries(panels)
        .filter(([name, show]) => {
            if (!PANEL_SELECTORS[name]) console.warn(`viewerDefaults.panels: unknown panel "${name}"`);
            return PANEL_SELECTORS[name] && show === false;
        })
        .map(([name]) => `${PANEL_SELECTORS[name]} { display: none !important; }`)
        .join("\n");
}

// Applies the DOM-side defaults (folders, bodyStatesOpen, panels) once the
// controls and windows are built. `app` is the SimView instance.
export function applyViewerDomDefaults(app, defaults) {
    if (!isPlainObject(defaults)) return;
    const gui = app.uiControls?.gui;
    for (const [title, open] of Object.entries(defaults.folders ?? {})) {
        const folder = gui?.foldersRecursive().find((f) => f.$title.textContent === title);
        if (!folder) console.warn(`viewerDefaults.folders: no folder titled "${title}"`);
        else if (open) folder.open();
        else folder.close();
    }
    if (typeof defaults.bodyStatesOpen === "boolean" && app.bodyStateWindow?.window) {
        app.bodyStateWindow.window.open = defaults.bodyStatesOpen;
    }
    const css = panelHideCss(defaults.panels);
    if (css) {
        const style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);
    }
}
