import { describe, expect, it } from "vitest";
import { WindowedField } from "../../simview/static/js/components/WindowedField.js";

// A fake blob server: serves float32 data from an in-memory buffer, honoring
// the Range header the way simview/server.py's /blob endpoint does, and
// recording every range it was asked for.
function fakeBlobServer(totalFrames, batchCount, width) {
    const values = new Float32Array(totalFrames * batchCount * width);
    for (let i = 0; i < values.length; i++) values[i] = i;
    const bytes = new Uint8Array(values.buffer);
    const requests = [];

    const fetchImpl = (url, options) => {
        const header = options?.headers?.Range ?? "";
        const [startText, endText] = header.replace("bytes=", "").split("-");
        const start = Number(startText);
        const end = Number(endText);
        requests.push({ start, end });
        const slice = bytes.slice(start, end + 1);
        return Promise.resolve({
            ok: true,
            status: 206,
            statusText: "Partial Content",
            arrayBuffer: () => Promise.resolve(slice.buffer),
        });
    };
    return { values, requests, fetchImpl };
}

// Enough frames that the field spans several windows at this width: at
// 8 batches x 3 floats = 96 bytes/frame, a window holds the 8192-frame cap.
const TOTAL_FRAMES = 30000;
const BATCHES = 8;
const WIDTH = 3;

function makeField(overrides = {}) {
    const server = fakeBlobServer(TOTAL_FRAMES, BATCHES, WIDTH);
    const field = new WindowedField("/blob/tok/0", {
        totalFrames: TOTAL_FRAMES,
        batchCount: BATCHES,
        width: WIDTH,
        fetchImpl: server.fetchImpl,
        ...overrides,
    });
    return { field, server };
}

// The value the fake server holds for (frame, batch, component).
function expectedValue(frame, batch, component) {
    return (frame * BATCHES + batch) * WIDTH + component;
}

describe("WindowedField", () => {
    it("returns null on the first read and fetches the covering window", async () => {
        const { field, server } = makeField();

        expect(field.rowsAt(0)).toBe(null);
        expect(server.requests.length).toBeGreaterThan(0);
        expect(server.requests[0].start).toBe(0);
    });

    it("serves correct rows once the window has landed", async () => {
        const { field } = makeField();
        field.rowsAt(0);
        await field.ensureWindowsFor(0);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const rows = field.rowsAt(3);
        expect(rows).toHaveLength(BATCHES);
        expect(rows[0]).toEqual([
            expectedValue(3, 0, 0),
            expectedValue(3, 0, 1),
            expectedValue(3, 0, 2),
        ]);
        expect(rows[BATCHES - 1][2]).toBe(expectedValue(3, BATCHES - 1, 2));
    });

    it("serves rows from a later window with the right frame offset", async () => {
        const { field } = makeField();
        const frame = field.windowFrames + 5; // second window
        field.rowsAt(frame);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const rows = field.rowsAt(frame);
        expect(rows[1]).toEqual([
            expectedValue(frame, 1, 0),
            expectedValue(frame, 1, 1),
            expectedValue(frame, 1, 2),
        ]);
    });

    it("fetches each window only once, however often it is read", async () => {
        const { field, server } = makeField();
        field.rowsAt(0);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const afterFirst = server.requests.length;

        for (let i = 0; i < 50; i++) field.rowsAt(i);
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(server.requests.length).toBe(afterFirst);
    });

    it("prefetches the next window so playback doesn't stall at the boundary", async () => {
        const { field, server } = makeField();
        field.rowsAt(0);
        await new Promise((resolve) => setTimeout(resolve, 0));

        // Window 0 and window 1 both requested up front.
        const starts = server.requests.map((r) => r.start).sort((a, b) => a - b);
        expect(starts).toContain(0);
        expect(starts).toContain(field.windowFrames * field.bytesPerFrame);

        // So the first frame of window 1 is already available.
        expect(field.rowsAt(field.windowFrames)).not.toBe(null);
    });

    it("evicts old windows instead of accumulating the whole trajectory", async () => {
        const { field } = makeField();
        // Walk far enough to touch many windows.
        for (let w = 0; w < 4; w++) {
            field.rowsAt(w * field.windowFrames);
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(field.residentWindows).toBeLessThanOrEqual(3);
    });

    it("returns null outside the trajectory rather than reading past the end", () => {
        const { field } = makeField();
        expect(field.rowsAt(-1)).toBe(null);
        expect(field.rowsAt(TOTAL_FRAMES)).toBe(null);
    });

    it("clamps the last window's range to the end of the blob", async () => {
        const { field, server } = makeField();
        field.rowsAt(TOTAL_FRAMES - 1);
        await new Promise((resolve) => setTimeout(resolve, 0));

        const totalBytes = TOTAL_FRAMES * field.bytesPerFrame;
        for (const request of server.requests) {
            expect(request.end).toBeLessThan(totalBytes);
        }
        expect(field.rowsAt(TOTAL_FRAMES - 1)).not.toBe(null);
    });

    it("survives a failed window fetch without throwing", async () => {
        const failing = () =>
            Promise.resolve({ ok: false, status: 500, statusText: "Boom" });
        const field = new WindowedField("/blob/tok/0", {
            totalFrames: TOTAL_FRAMES,
            batchCount: BATCHES,
            width: WIDTH,
            fetchImpl: failing,
        });

        expect(() => field.rowsAt(0)).not.toThrow();
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Still null -- the field is optional per frame, so the viewer just
        // goes without it rather than breaking.
        expect(field.rowsAt(0)).toBe(null);
    });
});
