// CCapture.js and its format-specific dependencies (webm-writer, gif.js,
// tar.js, download.js) are only needed if the user actually starts a
// recording. They're UMD/global-style scripts (not ES modules), so loading
// them lazily means injecting <script> tags rather than dynamic import().
const RECORDING_LIB_PATHS = [
    "../../lib/CCapture.js",
    "../../lib/webm-writer-0.2.0.js",
    "../../lib/gif.js",
    "../../lib/tar.js",
    "../../lib/download.js",
];

let loadPromise = null;

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = url;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
        document.head.appendChild(script);
    });
}

// Loads the recording libraries once (in order, since they attach to global
// scope and CCapture expects them to already be present) and caches the
// promise so repeat calls are no-ops.
export function loadRecordingLibs() {
    if (!loadPromise) {
        loadPromise = RECORDING_LIB_PATHS.reduce(
            (chain, path) =>
                chain.then(() => loadScript(new URL(path, import.meta.url).href)),
            Promise.resolve()
        );
    }
    return loadPromise;
}
