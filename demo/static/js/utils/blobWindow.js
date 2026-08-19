// Windowed fetching of a columnar field blob.
//
// A columnar field is one (T, B, k) float32 blob covering the whole run (see
// simview/columnar.py). For a long recording those add up: at 100k frames and
// 64 batches, one 3-wide vector field is ~77 MB, and a scene usually has
// several. The server serves those blobs with Range support, so a field only
// the *current frame* is ever read from -- velocity, angularVelocity, force,
// torque, none of which any whole-run consumer touches -- can be fetched in
// windows around the playhead instead of in full.
//
// bodyTransform and the scalars deliberately stay fully resident: trails, the
// error metrics, the terrain profile and the scalar plots all walk the entire
// trajectory, so windowing them would just move the cost around.
//
// Pure arithmetic, no fetch/DOM, so it's unit-testable on its own
// (tests/js/blobWindow.test.js). WindowedField in StateStore.js does the I/O.

// Fields worth windowing: read only for the frame currently on screen, and
// absent-from-a-frame is already a case every consumer handles (they're
// optional attributes -- see Body.updateState).
export const WINDOWABLE_FIELDS = new Set([
    "velocity",
    "angularVelocity",
    "force",
    "torque",
]);

// Below this, a field is small enough that fetching it whole is simpler and
// cheaper than issuing range requests around the playhead.
export const WINDOW_THRESHOLD_BYTES = 8 * 1024 * 1024;

// Roughly how much of a field to hold per window. Big enough that scrubbing
// around doesn't thrash, small enough that a few resident windows stay cheap.
const TARGET_WINDOW_BYTES = 1024 * 1024;
const MIN_WINDOW_FRAMES = 64;
const MAX_WINDOW_FRAMES = 8192;

// How many windows to keep before evicting the least recently used. Three
// covers the playhead's window plus the neighbours on either side, so ordinary
// playback and small scrubs never refetch.
export const MAX_RESIDENT_WINDOWS = 3;

export function bytesPerFrame(batchCount, width) {
    return Math.max(1, batchCount) * width * 4; // float32
}

export function shouldWindowField(fieldName, totalBytes, threshold) {
    const limit = Number.isFinite(threshold) ? threshold : WINDOW_THRESHOLD_BYTES;
    return WINDOWABLE_FIELDS.has(fieldName) && totalBytes > limit;
}

// Frames per window, chosen so one window is around TARGET_WINDOW_BYTES.
export function framesPerWindow(perFrameBytes) {
    if (!(perFrameBytes > 0)) return MIN_WINDOW_FRAMES;
    const frames = Math.round(TARGET_WINDOW_BYTES / perFrameBytes);
    return Math.min(MAX_WINDOW_FRAMES, Math.max(MIN_WINDOW_FRAMES, frames));
}

export function windowIndexFor(frameIndex, windowFrames) {
    if (!(windowFrames > 0)) return 0;
    return Math.floor(Math.max(0, frameIndex) / windowFrames);
}

// The byte range covering one window, clamped to the blob's end. Returns null
// for a window entirely past the end of the trajectory.
export function windowByteRange(
    windowIndex,
    windowFrames,
    totalFrames,
    perFrameBytes
) {
    const firstFrame = windowIndex * windowFrames;
    if (windowIndex < 0 || firstFrame >= totalFrames) return null;
    const frameCount = Math.min(windowFrames, totalFrames - firstFrame);
    const start = firstFrame * perFrameBytes;
    return {
        firstFrame,
        frameCount,
        start,
        // Inclusive, matching the HTTP Range header's convention.
        end: start + frameCount * perFrameBytes - 1,
    };
}

// Which windows to have resident for a playhead at `frameIndex`. The current
// one plus the next, so ordinary forward playback crosses a boundary into
// something already fetched.
export function windowsToPrefetch(frameIndex, windowFrames, totalFrames) {
    const current = windowIndexFor(frameIndex, windowFrames);
    const last = Math.max(0, Math.ceil(totalFrames / windowFrames) - 1);
    const wanted = [current];
    if (current + 1 <= last) wanted.push(current + 1);
    return wanted;
}

// Least-recently-used eviction: given the access order (oldest first) and the
// windows that must stay, returns the window indices to drop.
export function windowsToEvict(
    accessOrder,
    keep = [],
    maxResident = MAX_RESIDENT_WINDOWS
) {
    const pinned = new Set(keep);
    const evictable = accessOrder.filter((index) => !pinned.has(index));
    const overflow = accessOrder.length - maxResident;
    return overflow > 0 ? evictable.slice(0, overflow) : [];
}
