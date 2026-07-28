import { describe, expect, it } from "vitest";
import { pickDefaultBatchPair } from "../../simview/static/js/utils/batchPresets.js";

describe("pickDefaultBatchPair", () => {
    it("falls back to 0/1 with no recognizable batch names", () => {
        expect(pickDefaultBatchPair(["Batch 0", "Batch 1"])).toEqual({
            batchA: 0,
            batchB: 1,
        });
    });

    it("falls back to 0/0 for a single-batch scene", () => {
        expect(pickDefaultBatchPair(["Batch 0"])).toEqual({
            batchA: 0,
            batchB: 0,
        });
    });

    it("picks GT vs post-adaptation for DRIFT-style batch names", () => {
        const names = ["GT", "baseline", "pre-adaptation", "post-adaptation"];
        expect(pickDefaultBatchPair(names)).toEqual({ batchA: 0, batchB: 3 });
    });

    it("matches 'ground truth' and 'adapt' case-insensitively regardless of order", () => {
        expect(pickDefaultBatchPair(["Post-Adapt", "Ground Truth"])).toEqual({
            batchA: 1,
            batchB: 0,
        });
    });

    it("falls back to 0/1 when only one of the two patterns matches", () => {
        expect(pickDefaultBatchPair(["GT", "simulated"])).toEqual({
            batchA: 0,
            batchB: 1,
        });
    });

    it("falls back to 0/1 when the same name would match both patterns", () => {
        expect(pickDefaultBatchPair(["post-adapt-gt", "other"])).toEqual({
            batchA: 0,
            batchB: 1,
        });
    });
});
