import { describe, expect, it } from "vitest";
import { cosineSimilarityToQuery } from "../../simview/static/js/objects/similarity.js";

describe("cosineSimilarityToQuery", () => {
    const K = 3;
    // row 0: [1,0,0]; row 1: [2,0,0] (same direction, cosine=1);
    // row 2: [0,1,0] (orthogonal, cosine=0); row 3: [-1,0,0] (opposite, cosine=-1)
    const EMB = new Float32Array([1, 0, 0, 2, 0, 0, 0, 1, 0, -1, 0, 0]);

    it("returns 1 for the query point against itself", () => {
        const sims = cosineSimilarityToQuery(EMB, 0, K);
        expect(sims[0]).toBeCloseTo(1, 6);
    });

    it("returns 1 for a same-direction, different-magnitude row", () => {
        const sims = cosineSimilarityToQuery(EMB, 0, K);
        expect(sims[1]).toBeCloseTo(1, 6);
    });

    it("returns 0 for an orthogonal row", () => {
        const sims = cosineSimilarityToQuery(EMB, 0, K);
        expect(sims[2]).toBeCloseTo(0, 6);
    });

    it("returns -1 for an opposite-direction row", () => {
        const sims = cosineSimilarityToQuery(EMB, 0, K);
        expect(sims[3]).toBeCloseTo(-1, 6);
    });

    it("infers N from embeddingFlat.length/K when N isn't passed", () => {
        const sims = cosineSimilarityToQuery(EMB, 0, K);
        expect(sims.length).toBe(4);
    });

    it("returns 0 (not NaN) when the query vector is all-zero", () => {
        const emb = new Float32Array([0, 0, 0, 1, 2, 3]);
        const sims = cosineSimilarityToQuery(emb, 0, K);
        expect(sims[0]).toBe(0);
        expect(sims[1]).toBe(0);
    });

    it("returns 0 (not NaN) when a candidate vector is all-zero", () => {
        const emb = new Float32Array([1, 2, 3, 0, 0, 0]);
        const sims = cosineSimilarityToQuery(emb, 0, K);
        expect(sims[1]).toBe(0);
    });

    it("is symmetric: sim(a->b) === sim(b->a)", () => {
        const simsFrom0 = cosineSimilarityToQuery(EMB, 0, K);
        const simsFrom2 = cosineSimilarityToQuery(EMB, 2, K);
        expect(simsFrom0[2]).toBeCloseTo(simsFrom2[0], 6);
    });
});
