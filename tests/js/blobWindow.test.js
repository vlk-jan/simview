import { describe, expect, it } from "vitest";
import {
    MAX_RESIDENT_WINDOWS,
    WINDOW_THRESHOLD_BYTES,
    bytesPerFrame,
    framesPerWindow,
    shouldWindowField,
    windowByteRange,
    windowIndexFor,
    windowsToEvict,
    windowsToPrefetch,
} from "../../simview/static/js/utils/blobWindow.js";

describe("bytesPerFrame", () => {
    it("is batches x width x 4 (float32)", () => {
        expect(bytesPerFrame(2, 3)).toBe(24);
        expect(bytesPerFrame(64, 7)).toBe(1792);
    });

    it("treats a zero batch count as one rather than returning zero", () => {
        expect(bytesPerFrame(0, 3)).toBe(12);
    });
});

describe("shouldWindowField", () => {
    it("windows a large current-frame-only vector field", () => {
        expect(shouldWindowField("velocity", WINDOW_THRESHOLD_BYTES + 1)).toBe(true);
        expect(shouldWindowField("force", 100e6)).toBe(true);
    });

    it("leaves small fields fully resident", () => {
        expect(shouldWindowField("velocity", 1024)).toBe(false);
        expect(shouldWindowField("velocity", WINDOW_THRESHOLD_BYTES)).toBe(false);
    });

    it("never windows fields the whole-run consumers need", () => {
        // Trails, error metrics and the terrain profile walk every frame of
        // bodyTransform, so windowing it would just move the cost around.
        expect(shouldWindowField("bodyTransform", 500e6)).toBe(false);
    });
});

describe("framesPerWindow", () => {
    it("targets roughly a megabyte per window", () => {
        const perFrame = bytesPerFrame(64, 3); // 768 bytes
        const frames = framesPerWindow(perFrame);
        expect(frames * perFrame).toBeGreaterThan(512 * 1024);
        expect(frames * perFrame).toBeLessThan(2 * 1024 * 1024);
    });

    it("clamps to a sane range for tiny and huge frames", () => {
        expect(framesPerWindow(1)).toBe(8192); // would otherwise be ~1M frames
        expect(framesPerWindow(10e6)).toBe(64); // would otherwise be 0
        expect(framesPerWindow(0)).toBe(64);
    });
});

describe("windowIndexFor", () => {
    it("buckets frames into fixed-size windows", () => {
        expect(windowIndexFor(0, 100)).toBe(0);
        expect(windowIndexFor(99, 100)).toBe(0);
        expect(windowIndexFor(100, 100)).toBe(1);
        expect(windowIndexFor(250, 100)).toBe(2);
    });

    it("clamps a negative frame to the first window", () => {
        expect(windowIndexFor(-5, 100)).toBe(0);
    });
});

describe("windowByteRange", () => {
    it("covers exactly the window's frames", () => {
        expect(windowByteRange(1, 100, 1000, 24)).toEqual({
            firstFrame: 100,
            frameCount: 100,
            start: 2400,
            end: 4799, // inclusive
        });
    });

    it("clamps the last, partial window to the end of the trajectory", () => {
        expect(windowByteRange(2, 100, 250, 24)).toEqual({
            firstFrame: 200,
            frameCount: 50,
            start: 4800,
            end: 6000 - 1,
        });
    });

    it("returns null past the end", () => {
        expect(windowByteRange(3, 100, 250, 24)).toBe(null);
        expect(windowByteRange(-1, 100, 250, 24)).toBe(null);
    });
});

describe("windowsToPrefetch", () => {
    it("wants the current window and the next one", () => {
        expect(windowsToPrefetch(10, 100, 1000)).toEqual([0, 1]);
        expect(windowsToPrefetch(150, 100, 1000)).toEqual([1, 2]);
    });

    it("stops at the last window", () => {
        expect(windowsToPrefetch(950, 100, 1000)).toEqual([9]);
    });

    it("handles a trajectory shorter than one window", () => {
        expect(windowsToPrefetch(5, 100, 40)).toEqual([0]);
    });
});

describe("windowsToEvict", () => {
    it("keeps everything while under the resident limit", () => {
        expect(windowsToEvict([0, 1], [1])).toEqual([]);
    });

    it("drops the least recently used once over the limit", () => {
        const accessOrder = [0, 1, 2, 3]; // oldest first
        expect(windowsToEvict(accessOrder, [3], MAX_RESIDENT_WINDOWS)).toEqual([0]);
    });

    it("never evicts a pinned window even if it is the oldest", () => {
        const accessOrder = [0, 1, 2, 3, 4];
        // 0 is pinned (the playhead's window), so the next-oldest go instead.
        expect(windowsToEvict(accessOrder, [0], 3)).toEqual([1, 2]);
    });
});
