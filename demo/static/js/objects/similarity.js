/**
 * Cosine similarity from one "row" of a flat (N*K) embedding array to every
 * row, including itself (always 1, or 0 if the query vector is all-zero).
 *
 * Pure math, no THREE/DOM dependency -- factored out of Body.js's
 * recolorBySimilarity so it's unit-testable without constructing a real
 * Body (which needs a DOM TextureLoader.load(), unavailable under
 * vitest/Node -- see tests/js/Body.test.js's comment for why Body itself
 * isn't unit-tested here).
 *
 * @param {Float32Array} embeddingFlat - flat (N*K) embedding, row i at
 *   embeddingFlat[i*K .. i*K+K).
 * @param {number} queryIndex - row to compare every row against.
 * @param {number} K - embedding width (columns per row).
 * @param {number} N - number of rows (points/cells). Defaults to
 *   `embeddingFlat.length / K`.
 * @returns {Float32Array} length-N cosine similarities in [-1, 1].
 */
export function cosineSimilarityToQuery(embeddingFlat, queryIndex, K, N = embeddingFlat.length / K) {
    const qBase = queryIndex * K;
    let qNorm = 0;
    for (let k = 0; k < K; k++) qNorm += embeddingFlat[qBase + k] * embeddingFlat[qBase + k];
    qNorm = Math.sqrt(qNorm);

    const similarities = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        const base = i * K;
        let dot = 0;
        let norm = 0;
        for (let k = 0; k < K; k++) {
            dot += embeddingFlat[base + k] * embeddingFlat[qBase + k];
            norm += embeddingFlat[base + k] * embeddingFlat[base + k];
        }
        norm = Math.sqrt(norm);
        similarities[i] = norm > 0 && qNorm > 0 ? dot / (norm * qNorm) : 0;
    }
    return similarities;
}
