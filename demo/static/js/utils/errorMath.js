// Pure error-metric math shared by ErrorMetrics.js: per-frame Euclidean
// position error (combined and per-axis signed) and quaternion geodesic
// angle error between two batches of the same body.

// Signed per-axis difference (posA - posB) for one frame, given flat
// position arrays (3 floats per frame) and a frame index.
export function positionAxisError(posA, posB, frameIndex) {
    const base = frameIndex * 3;
    return {
        dx: posA[base] - posB[base],
        dy: posA[base + 1] - posB[base + 1],
        dz: posA[base + 2] - posB[base + 2],
    };
}

// Combined Euclidean position error for one frame.
export function positionError(posA, posB, frameIndex) {
    const { dx, dy, dz } = positionAxisError(posA, posB, frameIndex);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Geodesic angle (radians) between two quaternions, given flat [w,x,y,z]
// arrays (4 floats per frame) and a frame index. Uses |dot| to collapse the
// q/-q double cover (both represent the same rotation), so the result is
// always in [0, pi/2] measured this way -- doubled by callers that want the
// full [0, pi] rotation-angle convention (see below).
function quatDot(quatA, quatB, frameIndex) {
    const base = frameIndex * 4;
    return (
        quatA[base] * quatB[base] +
        quatA[base + 1] * quatB[base + 1] +
        quatA[base + 2] * quatB[base + 2] +
        quatA[base + 3] * quatB[base + 3]
    );
}

// Full geodesic rotation angle (radians) between two quaternions for one
// frame: 2*acos(|dot|), robust to floating-point dot products drifting
// slightly outside [-1, 1] and to either quaternion's sign (q and -q encode
// the same rotation).
export function quaternionAngleError(quatA, quatB, frameIndex) {
    const dot = quatDot(quatA, quatB, frameIndex);
    const clamped = Math.min(1, Math.max(-1, Math.abs(dot)));
    return 2 * Math.acos(clamped);
}

// Root-mean-square of a plain numeric array, over its finite entries (a NaN
// frame -- a gap in the trajectory -- is skipped, not poison). Returns 0 when
// nothing is finite (rather than NaN), so callers can display it directly.
export function rmse(values) {
    if (!values) return 0;
    let sumSq = 0;
    let count = 0;
    for (const v of values) {
        if (!Number.isFinite(v)) continue;
        sumSq += v * v;
        count++;
    }
    return count ? Math.sqrt(sumSq / count) : 0;
}

// Finds the maximum finite value in a plain numeric array and the index at
// which it occurs. Returns { value: 0, index: -1 } when nothing is finite.
export function maxWithIndex(values) {
    let bestValue = 0;
    let bestIndex = -1;
    if (!values) return { value: bestValue, index: bestIndex };
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        if (bestIndex < 0 || v > bestValue) {
            bestValue = v;
            bestIndex = i;
        }
    }
    return { value: bestValue, index: bestIndex };
}
