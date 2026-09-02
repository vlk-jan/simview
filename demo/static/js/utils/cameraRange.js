// How far the camera has to see, and how far out it may orbit, for a scene of
// a given horizontal extent. Pure arithmetic, no THREE/DOM, so it's unit
// testable on its own (see tests/js/cameraRange.test.js).
//
// The defaults in config.js are sized for the small scenes SimView started
// with (a few tens of metres). On a real recording -- a robot driving a few
// hundred metres across a mapped terrain -- a fixed 500 m far plane clips the
// terrain, and a fixed 500 m orbit limit means the whole run can never be
// framed at once. Both are treated as floors and widened from the terrain
// bounds instead.

// Framing a scene of diameter D at SimView's ~40 degree vertical FOV needs the
// camera roughly D / (2 * tan(fov/2)) ~= 1.4 * D away from the centre, so the
// orbit limit is 1.5 * D and the far plane covers that viewpoint plus the far
// side of the scene (2.5 * D), with a little margin on top.
const ORBIT_FACTOR = 1.5;
const FAR_FACTOR = 3;

export function cameraRangeForBounds(bounds, defaults = {}) {
    const far = Number.isFinite(defaults.far) ? defaults.far : 0;
    const maxDistance = Number.isFinite(defaults.maxDistance)
        ? defaults.maxDistance
        : 0;
    const fallback = { far, maxDistance };

    if (!bounds || typeof bounds !== "object") return fallback;
    const { minX, maxX, minY, maxY } = bounds;
    if (![minX, maxX, minY, maxY].every((v) => Number.isFinite(v))) return fallback;

    const diagonal = Math.hypot(maxX - minX, maxY - minY);
    if (!(diagonal > 0)) return fallback;

    return {
        far: Math.max(far, diagonal * FAR_FACTOR),
        maxDistance: Math.max(maxDistance, diagonal * ORBIT_FACTOR),
    };
}
