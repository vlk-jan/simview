// Decodes the binary state/model encodings the server uses to avoid shipping
// huge floating-point arrays as JSON text (see server.py / state.py):
// standalone `/blob/...` float32 buffers, and inline `__b64__`-prefixed
// base64 float32 strings embedded in per-body state fields.

// Detected once: true if the platform is little-endian, which lets blob decoding
// skip the per-element DataView conversion (blobs are always little-endian
// float32 by contract, matching Python's "<f4").
export const IS_LITTLE_ENDIAN = (() => {
    const buf = new ArrayBuffer(2);
    new Uint16Array(buf)[0] = 0x0102;
    return new Uint8Array(buf)[0] === 0x02;
})();

// Blobs are little-endian float32 by contract (Python "<f4"). On
// little-endian platforms (the overwhelming majority) the buffer can be
// reinterpreted directly with no per-element conversion; big-endian
// platforms fall back to a DataView-based byte swap.
export function decodeFloat32Blob(arrayBuffer) {
    if (IS_LITTLE_ENDIAN) {
        return new Float32Array(arrayBuffer);
    }
    const dataView = new DataView(arrayBuffer);
    const floatArray = new Float32Array(arrayBuffer.byteLength / 4);
    for (let i = 0; i < floatArray.length; i++) {
        floatArray[i] = dataView.getFloat32(i * 4, true); // true = little-endian
    }
    return floatArray;
}

// Per-body state fields that add_trajectory(binary=True) packs as float32
// `__b64__` blobs, with the trailing width used to reshape into per-batch rows.
export const STATE_FIELD_WIDTHS = {
    bodyTransform: 7,
    velocity: 3,
    angularVelocity: 3,
    force: 3,
    torque: 3,
};

// Decode a base64 float32 state field (little-endian, matching Python's "<f4")
// into an array of per-batch rows, e.g. [[x,y,z,w,qx,qy,qz], ...].
export function decodeStateField(str, width) {
    const bin = atob(str.slice(7)); // strip "__b64__"
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const floats = new Float32Array(bytes.buffer);
    const rows = new Array(floats.length / width);
    for (let r = 0; r < rows.length; r++) {
        const row = new Array(width);
        const base = r * width;
        for (let c = 0; c < width; c++) row[c] = floats[base + c];
        rows[r] = row;
    }
    return rows;
}

// Expand any binary-encoded per-body fields in a states chunk in place, so all
// downstream consumers see the same nested-array shape as legacy JSON states.
export function decodeStatesChunk(chunk) {
    const widths = STATE_FIELD_WIDTHS;
    for (const state of chunk) {
        if (!state.bodies) continue;
        for (const bodyState of state.bodies) {
            for (const field in widths) {
                const v = bodyState[field];
                if (typeof v === "string" && v.startsWith("__b64__")) {
                    bodyState[field] = decodeStateField(v, widths[field]);
                }
            }
        }
    }
}
