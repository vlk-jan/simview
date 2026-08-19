import { decodeFloat32Blob } from "../utils/blobCodec.js";
import {
    MAX_RESIDENT_WINDOWS,
    bytesPerFrame,
    framesPerWindow,
    windowByteRange,
    windowIndexFor,
    windowsToEvict,
    windowsToPrefetch,
} from "../utils/blobWindow.js";

// One columnar field fetched in windows around the playhead instead of whole,
// for long trajectories where the full (T, B, k) blob would be hundreds of
// megabytes. See utils/blobWindow.js for which fields qualify and why, and
// server.py's /blob endpoint for the Range support this relies on.
//
// `rowsAt(frameIndex)` is deliberately synchronous and may return null: the
// playback loop can't await, and every windowable field is an *optional*
// per-body attribute the viewer already tolerates missing from a frame (see
// Body.updateState). A miss therefore just means the arrow keeps its previous
// value for the frame or two until the window lands, rather than an error.
export class WindowedField {
    constructor(url, { totalFrames, batchCount, width, fetchImpl = null }) {
        this.url = url;
        this.totalFrames = totalFrames;
        this.batchCount = batchCount;
        this.width = width;
        // Wrapped rather than stored bare: calling a plain `fetch` reference
        // as a method would invoke it with `this` set to this object, which
        // browsers reject outright ("Illegal invocation").
        this._fetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));

        this.bytesPerFrame = bytesPerFrame(batchCount, width);
        this.windowFrames = framesPerWindow(this.bytesPerFrame);

        // windowIndex -> Float32Array covering that window's frames.
        this._windows = new Map();
        // windowIndex -> in-flight promise, so a window is only fetched once.
        this._pending = new Map();
        // windowIndex list, least recently used first.
        this._accessOrder = [];
        this.fetchCount = 0;
    }

    // Per-batch rows for this frame (e.g. [[vx, vy, vz], ...]), or null when
    // the covering window isn't resident yet -- in which case the fetch is
    // started and the caller simply goes without this field for now.
    rowsAt(frameIndex) {
        if (frameIndex < 0 || frameIndex >= this.totalFrames) return null;
        this.ensureWindowsFor(frameIndex);

        const windowIndex = windowIndexFor(frameIndex, this.windowFrames);
        const data = this._windows.get(windowIndex);
        if (!data) return null;
        this._touch(windowIndex);

        const offset = (frameIndex - windowIndex * this.windowFrames) * this.batchCount;
        const rows = new Array(this.batchCount);
        for (let b = 0; b < this.batchCount; b++) {
            const base = (offset + b) * this.width;
            const row = new Array(this.width);
            for (let c = 0; c < this.width; c++) row[c] = data[base + c];
            rows[b] = row;
        }
        return rows;
    }

    // Kicks off fetches for the window containing `frameIndex` and the one
    // after it, so ordinary forward playback crosses a boundary into something
    // already loaded.
    ensureWindowsFor(frameIndex) {
        for (const windowIndex of windowsToPrefetch(
            frameIndex,
            this.windowFrames,
            this.totalFrames
        )) {
            this._fetchWindow(windowIndex);
        }
    }

    _touch(windowIndex) {
        const at = this._accessOrder.indexOf(windowIndex);
        if (at !== -1) this._accessOrder.splice(at, 1);
        this._accessOrder.push(windowIndex);
    }

    _fetchWindow(windowIndex) {
        if (this._windows.has(windowIndex) || this._pending.has(windowIndex)) {
            return this._pending.get(windowIndex) ?? Promise.resolve();
        }
        const range = windowByteRange(
            windowIndex,
            this.windowFrames,
            this.totalFrames,
            this.bytesPerFrame
        );
        if (!range) return Promise.resolve();

        this.fetchCount++;
        const promise = this._fetch(this.url, {
            headers: { Range: `bytes=${range.start}-${range.end}` },
        })
            .then((response) => {
                if (!response.ok) {
                    throw new Error(
                        `Failed to fetch window ${windowIndex} of ${this.url}: ` +
                            `${response.status} ${response.statusText}`
                    );
                }
                return response.arrayBuffer();
            })
            .then((buffer) => {
                this._windows.set(windowIndex, decodeFloat32Blob(buffer));
                this._touch(windowIndex);
                this._evict();
            })
            .catch((error) => {
                // Non-fatal by design: the field is optional per frame, so a
                // failed window degrades to "no arrow" rather than a broken
                // viewer. Logged so it isn't silent.
                console.error(error);
            })
            .finally(() => {
                this._pending.delete(windowIndex);
            });

        this._pending.set(windowIndex, promise);
        return promise;
    }

    _evict() {
        const keep = windowsToPrefetch(
            (this._accessOrder[this._accessOrder.length - 1] ?? 0) *
                this.windowFrames,
            this.windowFrames,
            this.totalFrames
        );
        for (const windowIndex of windowsToEvict(
            this._accessOrder,
            keep,
            MAX_RESIDENT_WINDOWS
        )) {
            this._windows.delete(windowIndex);
            const at = this._accessOrder.indexOf(windowIndex);
            if (at !== -1) this._accessOrder.splice(at, 1);
        }
    }

    // How much of the field is actually in memory, for tests and debugging.
    get residentWindows() {
        return this._windows.size;
    }
}
