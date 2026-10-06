// Shareable-view-link encode/decode (see ui/Controls.js's "Copy view link"
// button and SimView.js's apply-on-load hook). Pure functions, no DOM/THREE
// dependencies, so they're unit-testable in isolation.
//
// Format (v=1): a compact `#key=value&key=value...` hash fragment, e.g.
//   #v=1&t=1.25&cam=1.5,2,3&tgt=0,0,0&fov=50&b=1&bvm=mesh&tcm=height&flags=5
// `flags` is a bitmask over the boolean toggles listed in BOOLEAN_FLAG_KEYS
// below (bit order fixed by that array's order) -- new booleans get appended
// at the end of the array in future versions so old links keep decoding
// sanely (their bits just default off for the new flag).
//
// Versioned via `v` so future formats can add/rename fields; parseViewState
// only understands v=1 today and returns null for anything else.

export const VIEW_STATE_VERSION = 1;

// Fixed bit order for the `flags` bitmask -- append-only across versions.
const BOOLEAN_FLAG_KEYS = [
    "axesVisible",
    "trailsVisible",
    "smoothInterpolation",
    "terrainProbe",
    "attributeVisible.contacts",
    "attributeVisible.velocity",
    "attributeVisible.angularVelocity",
    "attributeVisible.force",
    "attributeVisible.torque",
    "terrainVisualizationModes.surface",
    "terrainVisualizationModes.wireframe",
    "terrainVisualizationModes.normals",
];

// Deliberately NOT in the list above: `pointCloudsVisible`. It defaults on,
// so a bit would decode old links (bit absent) as off; it travels as the
// named `pc=0|1` key instead, where absent means "leave alone".

function getPath(obj, path) {
    return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

function fmtNum(n) {
    // Trim to a sane precision so the hash stays compact/human-tolerable,
    // while still round-tripping to full float precision for practical
    // view-restoration purposes (6 significant decimals).
    if (!Number.isFinite(n)) return "0";
    return Number(n.toFixed(6)).toString();
}

function fmtVec3(v) {
    return [fmtNum(v.x), fmtNum(v.y), fmtNum(v.z)].join(",");
}

function parseVec3(str) {
    if (typeof str !== "string") return null;
    const parts = str.split(",");
    if (parts.length !== 3) return null;
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return null;
    return { x: nums[0], y: nums[1], z: nums[2] };
}

// Builds the bitmask for `state.toggles` (a flat map of BOOLEAN_FLAG_KEYS ->
// boolean, see serializeViewState's `state` shape below).
function encodeFlags(toggles) {
    let mask = 0;
    BOOLEAN_FLAG_KEYS.forEach((key, i) => {
        if (toggles && toggles[key]) mask |= 1 << i;
    });
    return mask;
}

function decodeFlags(mask) {
    const toggles = {};
    BOOLEAN_FLAG_KEYS.forEach((key, i) => {
        toggles[key] = (mask & (1 << i)) !== 0;
    });
    return toggles;
}

// state shape (all fields optional):
// {
//   time: number,
//   camera: { position: {x,y,z}, target: {x,y,z}, fov: number },
//   batchIndex: number,
//   bodyVisualizationMode: string,
//   terrainColorMode: string,
//   toggles: { [key in BOOLEAN_FLAG_KEYS]?: boolean },
//   pointCloudsVisible: boolean,   // `pc=0|1` -- a named key, not a flag bit,
//                                  // so "absent" (leave alone) != false
//   trackBody: string,             // `track=`
//   terrainColorMap: string,       // `cmap=`
//   playbackSpeed: number,         // `speed=`
// }
export function serializeViewState(state) {
    if (!state || typeof state !== "object") return "";
    const params = [`v=${VIEW_STATE_VERSION}`];

    if (Number.isFinite(state.time)) {
        params.push(`t=${fmtNum(state.time)}`);
    }
    if (state.camera && state.camera.position) {
        params.push(`cam=${fmtVec3(state.camera.position)}`);
    }
    if (state.camera && state.camera.target) {
        params.push(`tgt=${fmtVec3(state.camera.target)}`);
    }
    if (state.camera && Number.isFinite(state.camera.fov)) {
        params.push(`fov=${fmtNum(state.camera.fov)}`);
    }
    if (Number.isInteger(state.batchIndex)) {
        params.push(`b=${state.batchIndex}`);
    }
    if (typeof state.bodyVisualizationMode === "string" && state.bodyVisualizationMode) {
        params.push(`bvm=${encodeURIComponent(state.bodyVisualizationMode)}`);
    }
    if (typeof state.terrainColorMode === "string" && state.terrainColorMode) {
        params.push(`tcm=${encodeURIComponent(state.terrainColorMode)}`);
    }
    if (state.toggles && typeof state.toggles === "object") {
        params.push(`flags=${encodeFlags(state.toggles)}`);
    }
    if (typeof state.pointCloudsVisible === "boolean") {
        params.push(`pc=${state.pointCloudsVisible ? 1 : 0}`);
    }
    if (typeof state.trackBody === "string" && state.trackBody) {
        params.push(`track=${encodeURIComponent(state.trackBody)}`);
    }
    if (typeof state.terrainColorMap === "string" && state.terrainColorMap) {
        params.push(`cmap=${encodeURIComponent(state.terrainColorMap)}`);
    }
    if (Number.isFinite(state.playbackSpeed) && state.playbackSpeed > 0) {
        params.push(`speed=${fmtNum(state.playbackSpeed)}`);
    }

    return `#${params.join("&")}`;
}

// Tolerant parser: malformed/unknown input never throws -- worst case it
// returns null (nothing to apply) or an object missing some keys (whatever
// could be salvaged). A bad hash must never break page load.
export function parseViewState(hash) {
    if (typeof hash !== "string") return null;
    // URLSearchParams never throws, even on malformed percent-encoding.
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    if (parseInt(params.get("v"), 10) !== VIEW_STATE_VERSION) return null;
    const num = (key) => (params.get(key) ? Number(params.get(key)) : NaN);

    const state = {};
    const t = num("t");
    if (Number.isFinite(t)) state.time = t;

    const camPos = parseVec3(params.get("cam"));
    const camTgt = parseVec3(params.get("tgt"));
    const fov = num("fov");
    if (camPos || camTgt || Number.isFinite(fov)) {
        state.camera = {};
        if (camPos) state.camera.position = camPos;
        if (camTgt) state.camera.target = camTgt;
        if (Number.isFinite(fov)) state.camera.fov = fov;
    }

    const b = parseInt(params.get("b"), 10);
    if (b >= 0) state.batchIndex = b;

    const bvm = params.get("bvm");
    if (bvm) state.bodyVisualizationMode = bvm;
    const tcm = params.get("tcm");
    if (tcm) state.terrainColorMode = tcm;

    const mask = parseInt(params.get("flags"), 10);
    if (Number.isInteger(mask)) state.toggles = decodeFlags(mask);

    const pc = params.get("pc");
    if (pc === "0" || pc === "1") state.pointCloudsVisible = pc === "1";
    const track = params.get("track");
    if (track) state.trackBody = track;
    const cmap = params.get("cmap");
    if (cmap) state.terrainColorMap = cmap;
    const speed = num("speed");
    if (Number.isFinite(speed) && speed > 0) state.playbackSpeed = speed;

    return state;
}

// Helper for callers building the `toggles` map from a live uiState object
// (see ui/Controls.js) -- flat-keyed via getPath so nested paths
// like "attributeVisible.contacts" work without callers reimplementing the
// dotted-path walk.
export function toggleMapFromUiState(uiState) {
    const toggles = {};
    BOOLEAN_FLAG_KEYS.forEach((key) => {
        toggles[key] = !!getPath(uiState, key);
    });
    return toggles;
}

// Startup-only hash keys, independent of `v=1`: `data=<base url>` (static data
// base) and `ui=0` (embedded mode, chrome hidden). Returns {data, ui} with
// data null when absent and ui true unless explicitly "0".
export function parseStartupOptions(hash) {
    if (typeof hash !== "string") return { data: null, ui: true };
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    return { data: params.get("data") || null, ui: params.get("ui") !== "0" };
}
