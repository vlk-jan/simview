// tar.js and download.js are only needed for the PNG-sequence recording
// format (each rendered frame is captured as a PNG blob and packed into a
// .tar via Tar.append()/Tar.save(), then saved with download()). The WEBM
// format needs no extra libraries at all -- it's captured natively via
// canvas.captureStream() + MediaRecorder and saved via a temporary <a
// download> link (see AnimationController.js). Both tar.js and download.js
// are UMD/global-style scripts (not ES modules), so loading them lazily
// means injecting <script> tags rather than dynamic import().
const RECORDING_LIB_PATHS = ["../../lib/tar.js", "../../lib/download.js"];

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

// Loads the PNG-sequence recording libraries once (in order, since they
// attach to global scope) and caches the promise so repeat calls are no-ops.
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
