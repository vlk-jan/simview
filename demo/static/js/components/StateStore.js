// Abstraction over the two wire shapes `/states` can come back as (see
// server.py::_columnarize_states and README.md "Binary state fields"):
//
//  - legacy: a plain JSON array of per-frame state objects, exactly as
//    before -- kept working for scenes the server can't safely columnarize.
//  - columnar (wire format v4): `{times, bodies, scalars}` where each body's
//    numeric fields and each scalar are a single whole-trajectory Float32Array
//    (shape (T, B, k) / (T, B), row-major) fetched from a `/blob/...` URL.
//
// Consumers (AnimationController, SimView, ScalarPlotter, ...) only ever see
// this common API, so the rest of the viewer doesn't need to know which wire
// shape the current scene used.

// Per-body numeric fields packed as whole-trajectory (T, B, k) blobs, with
// their trailing per-batch-row width. Matches STATE_FIELD_WIDTHS in
// blobCodec.js (the per-frame equivalent) and _STATE_FIELD_WIDTHS in
// server.py.
const COLUMNAR_FIELD_WIDTHS = {
    bodyTransform: 7,
    velocity: 3,
    angularVelocity: 3,
    force: 3,
    torque: 3,
};

class ColumnarStateStore {
    // `bodies`: [{name, fields: {fieldName: Float32Array}, contacts?}], each
    // fields Float32Array already reshaped to flat (T * B * k) row-major.
    // `scalars`: {scalarName: Float32Array}, each flat (T * B) row-major.
    constructor(times, bodies, scalars, simBatches) {
        this.times = times;
        this._bodies = bodies;
        this._scalars = scalars;
        this.simBatches = simBatches;
        // Single-frame memo: playback only ever touches one frame at a time,
        // so materializing the whole timeline into legacy-shaped objects up
        // front would defeat the point of storing it columnar in the first place.
        this._memoIndex = -1;
        this._memoFrame = null;
    }

    get length() {
        return this.times.length;
    }

    timeAt(i) {
        return this.times[i];
    }

    lastTime() {
        return this.times[this.times.length - 1];
    }

    // Slices one body's field at frame `i` into an array of per-batch rows,
    // e.g. bodyTransform -> [[x,y,z,w,qx,qy,qz], ...] (one row per batch).
    _sliceField(flatArray, width, i) {
        const B = this.simBatches;
        const base = i * B * width;
        const rows = new Array(B);
        for (let b = 0; b < B; b++) {
            const rowBase = base + b * width;
            const row = new Array(width);
            for (let c = 0; c < width; c++) row[c] = flatArray[rowBase + c];
            rows[b] = row;
        }
        return rows;
    }

    getFrame(i) {
        if (i === this._memoIndex) return this._memoFrame;

        const state = { time: this.times[i], bodies: [] };
        for (const body of this._bodies) {
            const bodyState = { name: body.name };
            for (const field in body.fields) {
                bodyState[field] = this._sliceField(
                    body.fields[field],
                    COLUMNAR_FIELD_WIDTHS[field],
                    i
                );
            }
            if (body.contacts) {
                bodyState.contacts = body.contacts[i] ?? null;
            }
            state.bodies.push(bodyState);
        }
        for (const name in this._scalars) {
            const flat = this._scalars[name];
            const B = this.simBatches;
            const base = i * B;
            state[name] = Array.from(flat.subarray(base, base + B));
        }

        this._memoIndex = i;
        this._memoFrame = state;
        return state;
    }

    // Per-batch series for the scalar plotter: [{x: time, y: value}, ...] per batch.
    // `simBatches` is accepted (and ignored) for API parity with
    // LegacyStateStore.getScalarSeries -- the columnar store already knows
    // its own batch count.
    getScalarSeries(name, _simBatches) {
        const flat = this._scalars[name];
        const B = this.simBatches;
        const series = new Array(B).fill().map(() => new Array(this.length));
        for (let i = 0; i < this.length; i++) {
            const base = i * B;
            for (let b = 0; b < B; b++) {
                series[b][i] = { x: this.times[i], y: flat[base + b] };
            }
        }
        return series;
    }
}

class LegacyStateStore {
    // `statesArray`: the classic array of per-frame state objects (already
    // decoded -- __b64__ fields expanded via decodeStatesChunk).
    constructor(statesArray) {
        this._states = statesArray;
    }

    // simBatches isn't known to the store itself in the legacy shape (each
    // state object carries its own per-batch arrays without a fixed count
    // recorded anywhere) -- callers pass it explicitly to getScalarSeries,
    // matching how ScalarPlotter/ErrorMetrics already get it from
    // app.batchManager.simBatches.

    get length() {
        return this._states.length;
    }

    // Recomputed on every access rather than cached, since `append()` can grow
    // `_states` after this store is already in use (live streaming) -- plain
    // arrays are cheap enough here that a stale cache isn't worth the risk.
    get times() {
        return this._states.map((s) => s.time);
    }

    timeAt(i) {
        return this._states[i].time;
    }

    lastTime() {
        return this._states[this._states.length - 1].time;
    }

    getFrame(i) {
        return this._states[i];
    }

    getScalarSeries(name, simBatches) {
        const series = new Array(simBatches).fill().map(() => []);
        for (const state of this._states) {
            const values = state[name];
            if (values === undefined) {
                throw new Error(`Scalar "${name}" not found in state.`);
            }
            for (let b = 0; b < simBatches; b++) {
                if (values[b] === undefined) {
                    throw new Error(`Scalar "${name}" not found in state at index ${b}.`);
                }
                series[b].push({ x: state.time, y: values[b] });
            }
        }
        return series;
    }

    // Grows the store in place with an already-decoded chunk of new frames
    // (live-streaming support -- see SimView.processStatesChunk). Returns the
    // index of the first newly-appended frame.
    append(chunk) {
        const startIndex = this._states.length;
        this._states.push(...chunk);
        return startIndex;
    }
}

export class StateStore {
    static fromColumnar({ times, bodies, scalars }, simBatches) {
        return new ColumnarStateStore(times, bodies, scalars, simBatches);
    }

    static fromLegacy(statesArray) {
        return new LegacyStateStore(statesArray);
    }
}
