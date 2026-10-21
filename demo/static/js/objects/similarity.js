// Cosine similarity from row `queryIndex` of a flat (N*K) embedding array
// (row i at embeddingFlat[i*K .. i*K+K)) to every row, including itself
// (always 1, or 0 if the query vector is all-zero). Returns a length-N
// Float32Array in [-1, 1]; N defaults to embeddingFlat.length / K. Pure
// math with no THREE/DOM dependency, shared by Body's point recoloring.
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
