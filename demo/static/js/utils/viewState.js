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

function getPath(obj, path) {
    return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

function setPath(obj, path, value) {
    const keys = path.split(".");
    let node = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
        node = node[k];
    }
    node[keys[keys.length - 1]] = value;
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

    return `#${params.join("&")}`;
}

// Tolerant parser: malformed/unknown input never throws -- worst case it
// returns null (nothing to apply) or an object missing some keys (whatever
// could be salvaged). A bad hash must never break page load.
export function parseViewState(hash) {
    try {
        if (typeof hash !== "string") return null;
        const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
        if (!trimmed) return null;

        const raw = {};
        for (const pair of trimmed.split("&")) {
            if (!pair) continue;
            const eq = pair.indexOf("=");
            if (eq === -1) continue;
            const key = pair.slice(0, eq);
            const value = pair.slice(eq + 1);
            if (key) raw[key] = value;
        }

        if (!("v" in raw)) return null;
        const version = parseInt(raw.v, 10);
        if (version !== VIEW_STATE_VERSION) return null; // unknown/unsupported version

        const state = {};

        if ("t" in raw) {
            const t = Number(raw.t);
            if (Number.isFinite(t)) state.time = t;
        }

        const camPos = "cam" in raw ? parseVec3(raw.cam) : null;
        const camTgt = "tgt" in raw ? parseVec3(raw.tgt) : null;
        const fov = "fov" in raw ? Number(raw.fov) : null;
        if (camPos || camTgt || (fov !== null && Number.isFinite(fov))) {
            state.camera = {};
            if (camPos) state.camera.position = camPos;
            if (camTgt) state.camera.target = camTgt;
            if (fov !== null && Number.isFinite(fov)) state.camera.fov = fov;
        }

        if ("b" in raw) {
            const b = parseInt(raw.b, 10);
            if (Number.isInteger(b) && b >= 0) state.batchIndex = b;
        }

        if ("bvm" in raw) {
            try {
                const bvm = decodeURIComponent(raw.bvm);
                if (bvm) state.bodyVisualizationMode = bvm;
            } catch {
                /* malformed percent-encoding: ignore this field */
            }
        }

        if ("tcm" in raw) {
            try {
                const tcm = decodeURIComponent(raw.tcm);
                if (tcm) state.terrainColorMode = tcm;
            } catch {
                /* malformed percent-encoding: ignore this field */
            }
        }

        if ("flags" in raw) {
            const mask = parseInt(raw.flags, 10);
            if (Number.isInteger(mask)) {
                state.toggles = decodeFlags(mask);
            }
        }

        return state;
    } catch {
        // Never let a malformed hash break page load.
        return null;
    }
}

// Helper for callers building the `toggles` map from a live uiState object
// (see ui/Controls.js) -- flat-keyed via getPath/setPath so nested paths
// like "attributeVisible.contacts" work without callers reimplementing the
// dotted-path walk.
export function toggleMapFromUiState(uiState) {
    const toggles = {};
    BOOLEAN_FLAG_KEYS.forEach((key) => {
        toggles[key] = !!getPath(uiState, key);
    });
    return toggles;
}

// Applies a decoded `toggles` map (as produced by decodeFlags/parseViewState)
// onto a target uiState-shaped object in place.
export function applyToggleMapToUiState(uiState, toggles) {
    if (!toggles) return;
    BOOLEAN_FLAG_KEYS.forEach((key) => {
        if (key in toggles) setPath(uiState, key, !!toggles[key]);
    });
}

export { BOOLEAN_FLAG_KEYS };
