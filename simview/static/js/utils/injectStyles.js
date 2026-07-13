const injectedStyleIds = new Set();

// Injects a <style> block into <head> exactly once per styleId, even across
// multiple instances of the same component. Cheap to call from a
// constructor every time -- repeat calls with an already-seen id are no-ops.
export function injectStyles(styleId, css) {
    if (injectedStyleIds.has(styleId) || document.getElementById(styleId)) {
        injectedStyleIds.add(styleId);
        return;
    }
    const styleElement = document.createElement("style");
    styleElement.id = styleId;
    styleElement.textContent = css;
    document.head.appendChild(styleElement);
    injectedStyleIds.add(styleId);
}
