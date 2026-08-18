import { describe, expect, it } from "vitest";
import {
    AUTO_FOCUS_THRESHOLD,
    RENDER_ALL,
    RENDER_FOCUSED,
    defaultRenderMode,
    visibleBatchSet,
} from "../../simview/static/js/utils/batchVisibility.js";

describe("defaultRenderMode", () => {
    it("renders everything for an ordinary handful of batches", () => {
        expect(defaultRenderMode(1)).toBe(RENDER_ALL);
        expect(defaultRenderMode(8)).toBe(RENDER_ALL);
        expect(defaultRenderMode(AUTO_FOCUS_THRESHOLD)).toBe(RENDER_ALL);
    });

    it("falls back to focused-only once an RL-scale env count is in play", () => {
        expect(defaultRenderMode(AUTO_FOCUS_THRESHOLD + 1)).toBe(RENDER_FOCUSED);
        expect(defaultRenderMode(256)).toBe(RENDER_FOCUSED);
    });
});

describe("visibleBatchSet", () => {
    it("includes every batch in 'all' mode", () => {
        expect(visibleBatchSet(RENDER_ALL, 4, 2)).toEqual(new Set([0, 1, 2, 3]));
    });

    it("includes only the active batch in 'focused' mode", () => {
        expect(visibleBatchSet(RENDER_FOCUSED, 100, 7)).toEqual(new Set([7]));
    });

    it("keeps pinned batches visible alongside the active one", () => {
        // e.g. split screen or the error-metrics A/B pair.
        expect(visibleBatchSet(RENDER_FOCUSED, 100, 7, [3, 9])).toEqual(
            new Set([7, 3, 9])
        );
    });

    it("ignores pinned indices that are out of range or not integers", () => {
        expect(visibleBatchSet(RENDER_FOCUSED, 4, 1, [9, -1, null, 2.5, 3])).toEqual(
            new Set([1, 3])
        );
    });

    it("never renders nothing when the active batch is out of range", () => {
        expect(visibleBatchSet(RENDER_FOCUSED, 4, 99)).toEqual(new Set([0]));
        expect(visibleBatchSet(RENDER_FOCUSED, 4, -1)).toEqual(new Set([0]));
    });

    it("returns an empty set for a scene with no batches at all", () => {
        expect(visibleBatchSet(RENDER_FOCUSED, 0, 0)).toEqual(new Set());
        expect(visibleBatchSet(RENDER_ALL, 0, 0)).toEqual(new Set());
    });
});
