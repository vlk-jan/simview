// Picks a sensible default Batch A / Batch B pair from a scene's batch
// display names, e.g. for the Error Metrics panel to compare against
// instead of always defaulting to batches 0 vs 1.
//
// Recognizes common ground-truth/adaptation naming (case-insensitive), such
// as DRIFT's ["GT", "baseline", "pre-adaptation", "post-adaptation"] scenes:
// batch A becomes the first name matching "gt"/"ground truth", batch B the
// first matching "post"/"adapt". Falls back to 0/1 (or 0/0 for a
// single-batch scene) when no name matches either pattern, or when the same
// batch would match both.
export function pickDefaultBatchPair(names) {
    const simBatches = names.length;
    const fallback = { batchA: 0, batchB: Math.min(1, simBatches - 1) };
    if (simBatches < 2) return fallback;

    const lower = names.map((n) => n.toLowerCase());
    const refIndex = lower.findIndex((n) => /\bgt\b|ground.?truth/.test(n));
    // Prefer a "post"-labeled batch (DRIFT's "post-adaptation") over a bare
    // "adapt" match, so "pre-adaptation" doesn't win just because it also
    // contains "adapt" when a more specific "post-adaptation" is present.
    const postIndex = lower.findIndex((n) => /post/.test(n));
    const targetIndex =
        postIndex !== -1 ? postIndex : lower.findIndex((n) => /adapt/.test(n));
    if (refIndex === -1 || targetIndex === -1 || refIndex === targetIndex) {
        return fallback;
    }
    return { batchA: refIndex, batchB: targetIndex };
}
