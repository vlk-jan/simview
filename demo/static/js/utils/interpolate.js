import * as THREE from "three";

// Pure helpers for smooth interpolated playback (see AnimationController.js).
// Every function here takes two arrays of per-batch rows (row shape depends
// on the field -- 7-wide [x,y,z,w,qx,qy,qz] for bodyTransform, 3-wide for
// plain vector attributes like velocity) plus alpha in [0, 1], and returns a
// new array of interpolated rows. Row counts of `rowsA`/`rowsB` may differ
// (e.g. a body only present in one of the two bracketing frames); rows
// beyond the shorter array's length pass through unchanged from the longer
// one, matching how the rest of the viewer already clamps batch indices.

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

// Linearly interpolates a single 3-vector row: [x, y, z].
export function lerpVector3Row(a, b, alpha) {
    return [
        a[0] + (b[0] - a[0]) * alpha,
        a[1] + (b[1] - a[1]) * alpha,
        a[2] + (b[2] - a[2]) * alpha,
    ];
}

// Interpolates an array of 3-vector rows (one per batch) by plain lerp.
export function lerpVectorRows(rowsA, rowsB, alpha) {
    if (!rowsA || !rowsB) return rowsA || rowsB;
    const n = Math.min(rowsA.length, rowsB.length);
    const out = new Array(rowsA.length);
    for (let i = 0; i < n; i++) {
        out[i] = lerpVector3Row(rowsA[i], rowsB[i], alpha);
    }
    for (let i = n; i < rowsA.length; i++) out[i] = rowsA[i];
    return out;
}

// Interpolates a single bodyTransform row [x, y, z, w, qx, qy, qz]: position
// lerp, quaternion slerp with shortest-path handling (negate one quaternion
// when the dot product is negative, since q and -q represent the same
// rotation but naive slerp between them takes the long way around).
export function interpolateTransformRow(a, b, alpha) {
    const px = a[0] + (b[0] - a[0]) * alpha;
    const py = a[1] + (b[1] - a[1]) * alpha;
    const pz = a[2] + (b[2] - a[2]) * alpha;

    _qa.set(a[4], a[5], a[6], a[3]); // THREE.Quaternion.set(x, y, z, w)
    _qb.set(b[4], b[5], b[6], b[3]);
    if (_qa.dot(_qb) < 0) {
        _qb.set(-b[4], -b[5], -b[6], -b[3]);
    }
    _qa.slerp(_qb, alpha);

    return [px, py, pz, _qa.w, _qa.x, _qa.y, _qa.z];
}

// Interpolates an array of bodyTransform rows (one per batch).
export function interpolateTransformRows(rowsA, rowsB, alpha) {
    if (!rowsA || !rowsB) return rowsA || rowsB;
    const n = Math.min(rowsA.length, rowsB.length);
    const out = new Array(rowsA.length);
    for (let i = 0; i < n; i++) {
        out[i] = interpolateTransformRow(rowsA[i], rowsB[i], alpha);
    }
    for (let i = n; i < rowsA.length; i++) out[i] = rowsA[i];
    return out;
}
