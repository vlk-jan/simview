import { PlaybackControls } from "../ui/PlaybackControls.js";
import { resolveStateBodies } from "../utils/bodyTransforms.js";
import { loadRecordingLibs } from "../utils/loadRecordingLibs.js";
import { interpolateTransformRows, lerpVectorRows } from "../utils/interpolate.js";

// Optional per-batch 3-vector attributes that get lerp'd alongside
// bodyTransform on the interpolated path. Everything else (contacts, and any
// other ragged/non-numeric field) snaps to the nearest frame instead.
const INTERPOLATED_VECTOR_ATTRS = ["velocity", "angularVelocity", "force", "torque"];

export class AnimationController {
    constructor(app, simulationTimestep) {
        this.app = app;
        this.playbackControls = null;
        this.store = null;
        this.isPlaying = false;
        this.playbackSpeed = 1;
        this.isRecording = false;
        this.isLoadingRecorder = false;
        this.capturer = null;
        this.startTime = null;
        this.recordingFormat = "webm"; // Default recording format
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

    getRecordingOptionsForFormat(format) {
        const options = {
            framerate: 60,
            verbose: false,
            display: true,
            autoSaveTime: 0,
        };

        switch (format) {
            case "webm":
                options.format = "webm";
                break;
            case "png":
                options.format = "png";
                break;
            default:
                throw new Error(`Unsupported format: ${format}`);
        }
        return options;
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
        this.isLoadingRecorder = true;
        try {
            await loadRecordingLibs();
        } finally {
            this.isLoadingRecorder = false;
        }
        if (this.isRecording) return;
        // Reset animation to start
        this.seekToIndex(0);
        const options = this.getRecordingOptionsForFormat(this.recordingFormat);
        // Initialize CCapture
        this.capturer = new CCapture(options);
        this.isRecording = true;
        this.startTime = performance.now();
        // Start recording and play animation if not already playing
        this.capturer.start();
        if (!this.isPlaying) {
            this.play();
        }
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
        this.capturer.stop();
        this.capturer.save();
        // Reset recording state
        this.startTime = null;
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
        if (this.isRecording && this.capturer) {
            const elapsed = now - this.startTime;
            const duration = this.totalTime * 1000; // Convert to milliseconds
            this.capturer.capture(this.app.scene.renderer.domElement);
            // Stop recording if we've completed one loop
            if (elapsed >= duration) {
                this.playbackControls.recordButtonClick();
            }
        }
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
        if (this.capturer) {
            this.capturer.stop();
            this.capturer = null;
        }
    }
}
