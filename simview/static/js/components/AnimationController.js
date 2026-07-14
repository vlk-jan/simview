import { PlaybackControls } from "../ui/PlaybackControls.js";
import { resolveStateBodies } from "../utils/bodyTransforms.js";
import { loadRecordingLibs } from "../utils/loadRecordingLibs.js";
import { interpolateTransformRows, lerpVectorRows } from "../utils/interpolate.js";

// Optional per-batch 3-vector attributes that get lerp'd alongside
// bodyTransform on the interpolated path. Everything else (contacts, and any
// other ragged/non-numeric field) snaps to the nearest frame instead.
const INTERPOLATED_VECTOR_ATTRS = ["velocity", "angularVelocity", "force", "torque"];

// Candidate MediaRecorder mimeTypes for the "webm" recording format, in
// preference order (VP9 first for better quality/size, VP8 as the widely
// supported fallback). Picked at runtime via MediaRecorder.isTypeSupported
// since browser support varies -- see pickSupportedMimeType().
const WEBM_MIME_CANDIDATES = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
];

// Some Chromium builds support recording directly to MP4 (H.264); when
// available it's exposed as an extra "mp4" option in the format dropdown
// (see PlaybackControls.js), purely as a nicety -- webm is always the
// fallback and works everywhere MediaRecorder does.
const MP4_MIME_CANDIDATES = ["video/mp4;codecs=avc1", "video/mp4"];

function pickSupportedMimeType(candidates) {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) {
        return null;
    }
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || null;
}

// Exported so PlaybackControls can decide whether to offer "mp4" in the
// format dropdown without duplicating the MediaRecorder feature-detection.
export function isMp4RecordingSupported() {
    return pickSupportedMimeType(MP4_MIME_CANDIDATES) !== null;
}

function extensionForMimeType(mimeType) {
    return mimeType.startsWith("video/mp4") ? "mp4" : "webm";
}

// Triggers a browser download of `blob` named `filename` via a temporary,
// never-appended <a download> link -- no library needed for this (CCapture's
// webm path used to pull in a `download()` helper from lib/download.js; the
// PNG-sequence path below still uses that helper since tar.js/download.js
// stay vendored for it).
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    // Revoke on a delay rather than immediately: some browsers kick off the
    // download asynchronously, and revoking the URL too early can abort it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class AnimationController {
    constructor(app, simulationTimestep) {
        this.app = app;
        this.playbackControls = null;
        this.store = null;
        this.isPlaying = false;
        this.playbackSpeed = 1;
        this.isRecording = false;
        this.isLoadingRecorder = false;
        this.startTime = null;
        this.recordingFormat = "webm"; // Default recording format

        // WEBM/MP4 recording state (native MediaRecorder path -- see
        // startRecording/stopRecording/captureFrame below). null when not
        // recording a video.
        this._mediaRecorder = null;
        this._captureTrack = null; // CanvasCaptureMediaStreamTrack, for requestFrame()
        this._recordedChunks = null;
        this._recordingMimeType = null;
        this._recordingStopped = null; // Promise resolved once the MediaRecorder actually stops

        // PNG-sequence recording state (tar.js-packed, see captureFrame below).
        this._pngTar = null;
        this._pngFrameCount = 0;
        // Promises for PNG frames still being encoded/appended asynchronously
        // (toBlob + arrayBuffer are both async) -- stopRecording awaits all of
        // these before calling tar.save(), so the last frame(s) of the loop
        // are never dropped from the archive.
        this._pngPending = [];
        this.currentStateIndex = 0;
        this.totalTime = 0; // Total animation time
        this.currentTime = 0; // Current time in the animation
        this.simulationTimestep = simulationTimestep; // Simulation timestep
        this.lastUpdateTime = null;

        // Memoizes the two resolveStateBodies() results bracketing the
        // current interpolation interval, keyed by their (lo, hi) state
        // indices -- consecutive RAF ticks (or scrubs) landing in the same
        // interval reuse both resolved frames instead of re-resolving.
        this._resolvedCache = { lo: -1, hi: -1, frameLo: null, frameHi: null };
    }

    loadAnimation(store) {
        if (!store || store.length === 0) {
            console.warn("No states received for animation.");
            return;
        }
        this.store = store;
        this.totalTime = this.store.lastTime();

        // Infer simulation timestep if not provided or invalid
        if ((!this.simulationTimestep || isNaN(this.simulationTimestep)) && this.store.length > 1) {
            const dt = this.store.timeAt(1) - this.store.timeAt(0);
            if (dt > 0) {
                console.log(`Inferred simulation timestep from states: ${dt}`);
                this.simulationTimestep = dt;
            } else {
                console.warn("Could not infer valid timestep from states, defaulting to 1/60");
                this.simulationTimestep = 1 / 60;
            }
        } else if (!this.simulationTimestep) {
            console.warn("No timestep provided and not enough states to infer. Defaulting to 1/60");
            this.simulationTimestep = 1 / 60;
        }

        this.playbackControls = new PlaybackControls(this);
        this.goToTime(0);
    }

    onStatesAppended() {
        if (this.store && this.store.length > 0) {
            this.totalTime = this.store.lastTime();
        }
        if (this.playbackControls) {
            this.playbackControls.forceRedraw();
        }
    }

    play() {
        if (!this.isPlaying) {
            this.isPlaying = true;
            this.lastUpdateTime = performance.now();
        }
    }

    pause() {
        this.isPlaying = false;
    }

    setSpeed(speed) {
        this.playbackSpeed = speed;
    }

    setRecordingFormat(format) {
        this.recordingFormat = format;
    }

    forceRedrawStaticElements() {
        this.playbackControls.forceRedraw();
        this.app.bodyStateWindow.forceRedraw();
    }

    // Binary search over store.timeAt(i) (time-ordered, but not necessarily
    // uniformly spaced -- adaptive-step simulations break the old
    // targetTime/simulationTimestep shortcut) for the index whose time is
    // nearest targetTime.
    getStateIndexForTime(targetTime) {
        const store = this.store;
        let lo = 0;
        let hi = store.length - 1;
        if (targetTime <= store.timeAt(lo)) return lo;
        if (targetTime >= store.timeAt(hi)) return hi;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (store.timeAt(mid) <= targetTime) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        // lo and hi now straddle targetTime; pick whichever is closer.
        return targetTime - store.timeAt(lo) <= store.timeAt(hi) - targetTime ? lo : hi;
    }

    // Binary search for the bracketing pair (lo, hi = lo+1 clamped) around
    // targetTime, plus alpha in [0, 1] for interpolating between them. Unlike
    // getStateIndexForTime this never rounds to the nearer frame -- it always
    // returns the pair straddling targetTime (or the boundary pair if
    // targetTime is outside the timeline).
    getBracketingIndices(targetTime) {
        const store = this.store;
        const last = store.length - 1;
        let lo = 0;
        let hi = last;
        if (targetTime <= store.timeAt(lo)) {
            return { lo, hi: Math.min(lo + 1, last), alpha: 0 };
        }
        if (targetTime >= store.timeAt(hi)) {
            return { lo: Math.max(hi - 1, 0), hi, alpha: 1 };
        }
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (store.timeAt(mid) <= targetTime) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        const tLo = store.timeAt(lo);
        const tHi = store.timeAt(hi);
        const span = tHi - tLo;
        const alpha = span > 0 ? (targetTime - tLo) / span : 0; // guard duplicate timestamps
        return { lo, hi, alpha };
    }

    seekToIndex(index) {
        this.currentStateIndex = index;
        this.currentTime = this.store.timeAt(index);
        this.updateScene();
    }

    stepForward() {
        if (this.isPlaying) return; // Ignore if playing
        const newIndex = (this.currentStateIndex + 1) % this.store.length;
        this.seekToIndex(newIndex);
        this.forceRedrawStaticElements();
    }

    stepBackward() {
        if (this.isPlaying) return; // Ignore if playing
        const newIndex =
            (this.currentStateIndex - 1 + this.store.length) % this.store.length;
        this.seekToIndex(newIndex);
        this.forceRedrawStaticElements();
    }

    goToTime(time) {
        time = Math.min(Math.max(time, 0), this.totalTime); // Clamp out-of-bounds time
        if (this.app.uiState?.smoothInterpolation) {
            // Keep the exact scrubbed time (not snapped to the nearest frame) so
            // the interpolated path in updateScene() can render in-between poses;
            // currentStateIndex still tracks the nearest frame for index-snapped
            // consumers (BodyStateWindow, ScalarPlotter, ErrorMetrics, trails).
            this.currentTime = time;
            this.currentStateIndex = this.getStateIndexForTime(time);
            this.updateScene();
        } else {
            const index = this.getStateIndexForTime(time);
            this.seekToIndex(index);
        }
        if (!this.isPlaying) {
            this.forceRedrawStaticElements();
        }
    }

    async startRecording() {
        if (this.isRecording || this.isLoadingRecorder) return;

        if (this.recordingFormat === "png") {
            // Only the PNG-sequence path needs the lazily-loaded tar.js/download.js
            // (see loadRecordingLibs.js) -- webm/mp4 recording is all native
            // MediaRecorder APIs, nothing to load.
            this.isLoadingRecorder = true;
            try {
                await loadRecordingLibs();
            } finally {
                this.isLoadingRecorder = false;
            }
        }
        if (this.isRecording) return;

        // Reset animation to start; the recording always captures exactly one
        // full loop from time 0 (see captureFrame's auto-stop below).
        this.seekToIndex(0);

        if (this.recordingFormat === "png") {
            this._pngTar = new Tar();
            this._pngFrameCount = 0;
            this._pngPending = [];
        } else {
            if (!this.#startVideoRecording()) return;
        }

        this.isRecording = true;
        this.startTime = performance.now();
        if (!this.isPlaying) {
            this.play();
        }
    }

    // Sets up canvas.captureStream() + MediaRecorder for the webm/mp4 format.
    // Returns false (and leaves no half-initialized state behind) if the
    // browser lacks the needed APIs.
    #startVideoRecording() {
        const canvas = this.app.scene.renderer.domElement;
        if (typeof canvas.captureStream !== "function") {
            console.error("This browser does not support canvas.captureStream(); cannot record video.");
            return false;
        }

        const mimeType =
            this.recordingFormat === "mp4"
                ? pickSupportedMimeType(MP4_MIME_CANDIDATES)
                : pickSupportedMimeType(WEBM_MIME_CANDIDATES);
        if (!mimeType || typeof MediaRecorder === "undefined") {
            console.error("This browser does not support MediaRecorder; cannot record video.");
            return false;
        }

        // captureStream(0) puts the track in "manual" mode: it only produces a
        // new frame when track.requestFrame() is called, which captureFrame()
        // below does once per actually-rendered frame -- deterministic
        // frame-for-frame capture instead of a realtime capture racing the
        // simulation's own timestep. Fall back to a realtime 60fps stream if
        // requestFrame isn't supported (older browsers).
        const stream = canvas.captureStream(0);
        const [track] = stream.getVideoTracks();
        if (!track || typeof track.requestFrame !== "function") {
            this._captureTrack = null;
            stream.getTracks().forEach((t) => t.stop());
            this._mediaRecorder = new MediaRecorder(canvas.captureStream(60), { mimeType });
        } else {
            this._captureTrack = track;
            this._mediaRecorder = new MediaRecorder(stream, { mimeType });
        }

        this._recordingMimeType = mimeType;
        this._recordedChunks = [];
        this._mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                this._recordedChunks.push(event.data);
            }
        };
        this._recordingStopped = new Promise((resolve) => {
            this._mediaRecorder.onstop = resolve;
        });
        this._mediaRecorder.start();
        return true;
    }

    getTotalTime() {
        return this.totalTime;
    }

    getCurrentTime() {
        return this.currentTime;
    }

    getCurrentStateIndex() {
        return this.currentStateIndex;
    }

    getCurrentState() {
        return this.store.getFrame(this.currentStateIndex);
    }

    stopRecording() {
        if (!this.isRecording) return;
        this.isRecording = false;
        this.startTime = null;

        if (this._pngTar) {
            this.#stopPngRecording();
            return;
        }

        this.#stopVideoRecording();
    }

    async #stopPngRecording() {
        const tar = this._pngTar;
        this._pngTar = null;
        this._pngFrameCount = 0;
        // Wait for every in-flight toBlob()/arrayBuffer() encode to finish
        // appending to the tar before saving it, so the last frame(s)
        // captured before the auto-stop aren't silently dropped.
        const pending = this._pngPending;
        this._pngPending = [];
        await Promise.all(pending);

        const blob = tar.save();
        download(blob, "simview-recording.tar", "application/x-tar");
    }

    async #stopVideoRecording() {
        const recorder = this._mediaRecorder;
        if (!recorder) return;
        const stopped = this._recordingStopped;
        if (recorder.state !== "inactive") {
            recorder.stop();
        }
        await stopped;

        const chunks = this._recordedChunks || [];
        const mimeType = this._recordingMimeType || "video/webm";
        const blob = new Blob(chunks, { type: mimeType });
        downloadBlob(blob, `simview-recording.${extensionForMimeType(mimeType)}`);

        if (this._captureTrack) {
            this._captureTrack.stop();
        }
        this._mediaRecorder = null;
        this._captureTrack = null;
        this._recordedChunks = null;
        this._recordingMimeType = null;
        this._recordingStopped = null;
    }

    animate(now) {
        if (!this.isPlaying || !this.store) return;
        if (this.lastUpdateTime === null) {
            this.lastUpdateTime = now;
        }
        const dt = (now - this.lastUpdateTime) / 1000;
        this.lastUpdateTime = now;
        this.currentTime += dt * this.playbackSpeed;
        if (this.totalTime > 0) {
            this.currentTime = this.currentTime % this.totalTime;
        } else {
            this.currentTime = 0; // Single-state scene: totalTime % would be NaN
        }
        const newStateIndex = this.getStateIndexForTime(this.currentTime);
        const indexChanged = newStateIndex !== this.currentStateIndex;
        this.currentStateIndex = newStateIndex;

        if (this.app.uiState?.smoothInterpolation) {
            // Interpolated path: render every tick regardless of whether the
            // nearest index changed, so bodies move smoothly between states
            // instead of snapping. Index-snapped consumers (playbackControls'
            // frame counter, bodyStateWindow readouts) still only refresh
            // when the nearest frame actually changes -- their own throttles
            // also apply, matching today's cadence.
            this.updateScene();
            if (indexChanged) {
                if (this.playbackControls) {
                    this.playbackControls.animate(now);
                }
                if (this.app.bodyStateWindow) {
                    this.app.bodyStateWindow.animate(now);
                }
            }
        } else if (indexChanged) {
            this.updateScene();
            if (this.playbackControls) {
                this.playbackControls.animate(now);
            }
            if (this.app.bodyStateWindow) {
                this.app.bodyStateWindow.animate(now);
            }
        }
    }

    captureFrame(now) {
        if (!this.isRecording) return;
        const elapsed = now - this.startTime;
        const duration = this.totalTime * 1000; // Convert to milliseconds

        if (this._pngTar) {
            this.#capturePngFrame();
        } else if (this._captureTrack) {
            // Manual-mode capture stream (see #startVideoRecording): pull
            // exactly one new frame per actually-rendered frame, so the
            // output is frame-for-frame deterministic rather than racing a
            // realtime clock.
            this._captureTrack.requestFrame();
        }
        // Realtime (non-manual) MediaRecorder streams need no per-frame call
        // here -- the browser samples the canvas on its own timer.

        // Stop recording if we've completed one loop
        if (elapsed >= duration) {
            this.playbackControls.recordButtonClick();
        }
    }

    // Encodes the current canvas as a PNG blob and appends it to the in-progress
    // tar (see startRecording/stopRecording) -- this is all CCapture's old "png"
    // format did, just without CCapture itself. Frame filenames are zero-padded
    // so a naive lexicographic sort (e.g. `tar tf` or an archive browser)
    // reconstructs playback order, matching CCapture's own PNG-sequence naming.
    #capturePngFrame() {
        const canvas = this.app.scene.renderer.domElement;
        const tar = this._pngTar;
        const index = this._pngFrameCount++;
        const encoded = new Promise((resolve) => {
            canvas.toBlob((blob) => {
                if (!blob || !tar) {
                    resolve();
                    return;
                }
                blob
                    .arrayBuffer()
                    .then((buf) => {
                        const name = String(index).padStart(7, "0") + ".png";
                        tar.append(name, new Uint8Array(buf));
                    })
                    .finally(resolve);
            }, "image/png");
        });
        this._pngPending.push(encoded);
    }

    // Single-frame PNG screenshot (see ui/PlaybackControls.js's camera button
    // and the "S" keyboard shortcut). Renders the scene once immediately
    // before capturing -- the renderer is created with preserveDrawingBuffer
    // (see config.js RENDERER_CONFIG), so the canvas already holds the last
    // rendered frame's pixels, but re-rendering synchronously first guards
    // against capturing a stale frame if this fires between animation ticks
    // (e.g. right after a scrub, before the next rAF has redrawn). Downloads
    // as `simview_t<currentTime>s.png` via a temporary <a download>, same
    // pattern as downloadBlob() above.
    captureScreenshot() {
        const { scene, renderer } = this.app.scene;
        const camera = this.app.scene.camera;
        renderer.render(scene, camera);
        const canvas = renderer.domElement;
        canvas.toBlob((blob) => {
            if (!blob) {
                console.error("Screenshot capture failed: canvas.toBlob returned null.");
                return;
            }
            const time = this.currentTime.toFixed(3);
            downloadBlob(blob, `simview_t${time}s.png`);
        }, "image/png");
    }

    updateScene() {
        if (!this.app.bodies || this.currentStateIndex >= this.store.length) return;
        if (this.app.uiState?.smoothInterpolation && this.store.length > 1) {
            this.updateSceneInterpolated();
        } else {
            this.updateSceneSnapped();
        }
        if (this.app.scalarPlotter) {
            this.app.scalarPlotter.setEndIndex(this.currentStateIndex);
        }
    }

    // Exactly today's behavior: render the nearest recorded frame, no
    // interpolation. Used whenever smooth interpolation is turned off.
    updateSceneSnapped() {
        const state = this.store.getFrame(this.currentStateIndex);
        // Resolve parent-relative (rigid/articulated) transforms and expand
        // grouped names into ordinary absolute-world transforms, then update
        // each body exactly as before.
        const resolved = resolveStateBodies(
            this.app.bodyMeta,
            this.app.bodyTopoOrder,
            this.app.batchManager.simBatches,
            state.bodies
        );
        resolved.forEach((resolvedBodyState, name) => {
            const body = this.app.bodies.get(name);
            if (body) {
                // Update the body state - this handles both batched and non-batched formats
                body.updateState(resolvedBodyState);
            }
        });
    }

    // Resolves the two frames bracketing this.currentTime (memoized by (lo, hi)
    // so consecutive ticks/scrubs within the same interval don't re-resolve),
    // then linearly interpolates position/vector attributes and slerps
    // orientation between them before handing each body its blended state.
    updateSceneInterpolated() {
        const { lo, hi, alpha } = this.getBracketingIndices(this.currentTime);

        let { frameLo, frameHi } = this._resolvedCache;
        if (this._resolvedCache.lo !== lo || this._resolvedCache.hi !== hi) {
            const simBatches = this.app.batchManager.simBatches;
            frameLo = resolveStateBodies(
                this.app.bodyMeta,
                this.app.bodyTopoOrder,
                simBatches,
                this.store.getFrame(lo).bodies
            );
            frameHi =
                hi === lo
                    ? frameLo
                    : resolveStateBodies(
                          this.app.bodyMeta,
                          this.app.bodyTopoOrder,
                          simBatches,
                          this.store.getFrame(hi).bodies
                      );
            this._resolvedCache = { lo, hi, frameLo, frameHi };
        }

        // Union of body names resolved in either bracketing frame -- a body
        // only present in one (e.g. just appeared/disappeared this frame)
        // falls back to a nearest-frame snap for that body instead of being
        // dropped.
        const names = new Set([...frameLo.keys(), ...frameHi.keys()]);
        names.forEach((name) => {
            const body = this.app.bodies.get(name);
            if (!body) return;

            const a = frameLo.get(name);
            const b = frameHi.get(name);
            if (!a || !b) {
                // Present in only one bracketing frame: nothing sensible to
                // interpolate against, snap to whichever exists.
                body.updateState(a || b);
                return;
            }

            body.updateState(this.interpolateBodyState(a, b, alpha));
        });
    }

    // Blends two resolved bodyState entries (same shape resolveStateBodies
    // produces) into one interpolated bodyState: bodyTransform position lerp +
    // quaternion slerp (shortest path), optional vector attributes lerp'd,
    // everything else (contacts, and any other ragged field) snaps to
    // whichever frame alpha is closer to.
    interpolateBodyState(a, b, alpha) {
        const out = { ...(alpha < 0.5 ? a : b) };

        if (a.bodyTransform && b.bodyTransform) {
            const rowsA = Array.isArray(a.bodyTransform[0]) ? a.bodyTransform : [a.bodyTransform];
            const rowsB = Array.isArray(b.bodyTransform[0]) ? b.bodyTransform : [b.bodyTransform];
            out.bodyTransform = interpolateTransformRows(rowsA, rowsB, alpha);
        }

        INTERPOLATED_VECTOR_ATTRS.forEach((attr) => {
            if (!a[attr] || !b[attr]) return;
            const rowsA = Array.isArray(a[attr][0]) ? a[attr] : [a[attr]];
            const rowsB = Array.isArray(b[attr][0]) ? b[attr] : [b[attr]];
            out[attr] = lerpVectorRows(rowsA, rowsB, alpha);
        });

        return out;
    }

    dispose() {
        if (this.playbackControls) {
            this.playbackControls.dispose();
            this.playbackControls = null;
        }
        if (this.isRecording) {
            this.isRecording = false;
            if (this._mediaRecorder && this._mediaRecorder.state !== "inactive") {
                this._mediaRecorder.stop();
            }
            if (this._captureTrack) {
                this._captureTrack.stop();
            }
            this._mediaRecorder = null;
            this._captureTrack = null;
            this._recordedChunks = null;
            this._pngTar = null;
            this._pngPending = [];
        }
    }
}
