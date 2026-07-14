import { PlaybackControls } from "../ui/PlaybackControls.js";
import { resolveStateBodies } from "../utils/bodyTransforms.js";
import { loadRecordingLibs } from "../utils/loadRecordingLibs.js";

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
        const index = this.getStateIndexForTime(time);
        this.seekToIndex(index);
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
        // Update state if changed
        if (newStateIndex !== this.currentStateIndex) {
            this.seekToIndex(newStateIndex);
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
        if (this.app.scalarPlotter) {
            this.app.scalarPlotter.setEndIndex(this.currentStateIndex);
        }
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
