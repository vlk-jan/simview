// Decodes the binary state/model encodings the server uses to avoid shipping
// huge floating-point arrays as JSON text (see server.py / state.py):
// standalone `/blob/...` float32 buffers, and inline `__b64__`-prefixed
// base64 float32 strings embedded in per-body state fields.

// Per-body state fields that add_trajectory(binary=True) packs as float32
// `__b64__` blobs, with the trailing width used to reshape into per-batch rows.
export const STATE_FIELD_WIDTHS = {
    bodyTransform: 7,
    velocity: 3,
    angularVelocity: 3,
    force: 3,
    torque: 3,
};

// Decode a base64 float32 state field (little-endian, matching Python's "<f4";
// browsers only run on little-endian platforms) into an array of per-batch
// rows, e.g. [[x,y,z,w,qx,qy,qz], ...].
export function decodeStateField(str, width) {
    const bytes = Uint8Array.from(atob(str.slice(7)), (c) => c.charCodeAt(0)); // strip "__b64__"
    const floats = new Float32Array(bytes.buffer);
    if (floats.length % width !== 0) {
        // Mirrors Python's _decode_state_field_rows: a partial trailing row
        // means a corrupt/mis-sized field, not something to silently truncate.
        throw new Error(
            `Binary state field has ${floats.length} floats, not a multiple of width ${width}`
        );
    }
    return Array.from({ length: floats.length / width }, (_, r) =>
        Array.from(floats.subarray(r * width, (r + 1) * width))
    );
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
