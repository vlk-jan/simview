import { FREQ_CONFIG } from "../config.js";
import { isEditableTarget } from "../utils/keyboard.js";
import { isMp4RecordingSupported } from "../components/AnimationController.js";
import {
    episodeIndexAt,
    episodeLabel,
    episodeSegments,
    nextEpisodeStart,
    normalizeEpisodes,
    previousEpisodeStart,
} from "../utils/episodes.js";

export class PlaybackControls {
    constructor(animationController) {
        this.animationController = animationController;
        // Episode boundaries, set later via setEpisodes() -- they come from the
        // model, which may not be loaded yet, and in live mode can arrive (and
        // change) at any point during the run. `rawEpisodes` is kept so the
        // list can be re-normalized as the timeline grows.
        this.rawEpisodes = [];
        this.episodes = [];
        this.minRenderDelay = 1000 / FREQ_CONFIG.playbackControls;
        this.lastRenderTime = Number.NEGATIVE_INFINITY;
        this.container = document.createElement("div");
        this.container.className = "sv-playback";

        this.controlsRow = document.createElement("div");
        this.controlsRow.className = "sv-playback-row";

        // One signal tears down every listener in dispose().
        this.abortController = new AbortController();
        const { signal } = this.abortController;

        const recordButtonClick = () => {
            if (this.animationController.isRecording) {
                this.animationController.stopRecording();
                this.recordButton.textContent = "⚫ REC";
                this.recordButton.classList.remove("is-recording");
            } else if (this.animationController.startRecording()) {
                this.recordButton.textContent = "⬛ STOP";
                this.recordButton.classList.add("is-recording");
            }
        };

        const formatSelectChange = (e) => {
            this.animationController.setRecordingFormat(e.target.value);
        };

        const screenshotButtonClick = () => {
            this.animationController.captureScreenshot();
        };

        const playButtonClick = () => {
            if (this.animationController.isPlaying) {
                this.animationController.pause();
                this.playButton.textContent = "Play";
            } else {
                this.animationController.play();
                this.playButton.textContent = "Pause";
            }
        };

        const stepBackButtonClick = () => {
            this.animationController.pause();
            this.animationController.stepBackward();
            this.playButton.textContent = "Play";
        };

        const stepForwardButtonClick = () => {
            this.animationController.pause();
            this.animationController.stepForward();
            this.playButton.textContent = "Play";
        };

        const speedSelectChange = (e) => {
            console.debug("Speed changed to", e.target.value);
            this.animationController.setSpeed(parseFloat(e.target.value));
        };

        const prevEpisodeButtonClick = () => {
            this.#jumpToFrame(
                previousEpisodeStart(
                    this.episodes,
                    this.animationController.getCurrentStateIndex()
                )
            );
        };

        const nextEpisodeButtonClick = () => {
            this.#jumpToFrame(
                nextEpisodeStart(
                    this.episodes,
                    this.animationController.getCurrentStateIndex()
                )
            );
        };

        const progressBarContainerClick = (event) => {
            const rect = this.progressBarContainer.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const progress = x / rect.width;
            const targetTime =
                this.animationController.getFirstTime() +
                progress * this.animationController.getTotalTime();

            if (event.altKey) {
                this.animationController.pause();
                this.playButton.textContent = "Play";
            }
            this.animationController.goToTime(targetTime);
        };

        const keydownListener = (event) => {
            if (isEditableTarget(event)) return;
            const key = event.key;

            // Handle arrow keys with Alt modifier for timeline stepping
            if (event.altKey) {
                if (key === "ArrowRight") {
                    event.stopPropagation();
                    event.preventDefault();
                    this.animationController.stepForward();
                    return;
                }
                if (key === "ArrowLeft") {
                    event.stopPropagation();
                    event.preventDefault();
                    this.animationController.stepBackward();
                    return;
                }
            }

            // Other keys (only if no modifiers are pressed)
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
                return;

            switch (key) {
                case "[":
                    this.prevEpisodeButton.click();
                    break;
                case "]":
                    this.nextEpisodeButton.click();
                    break;
                case "r":
                    // A hidden recording panel (display: none on the wrapper)
                    // disables the shortcut too. Checked on the button, not
                    // the wrapper, which is display: contents and has no box.
                    if (this.recordButton.getClientRects().length) this.recordButton.click();
                    break;
                case "s":
                    if (this.screenshotButton.getClientRects().length) this.screenshotButton.click();
                    break;
                case " ":
                    this.playButton.click();
                    event.target.blur();
                    break;
            }
        };

        this.recordButton = this.#createButton(
            "⚫ REC",
            recordButtonClick,
            "100px"
        );

        this.screenshotButton = this.#createButton(
            "📷",
            screenshotButtonClick,
            "40px"
        );
        this.screenshotButton.title = "Screenshot (S)";

        this.formatSelect = document.createElement("select");
        // "mp4" is only offered when this browser's MediaRecorder can
        // actually produce it (see isMp4RecordingSupported) -- webm is
        // always available wherever MediaRecorder is, so it's the
        // unconditional default/fallback.
        const formats = isMp4RecordingSupported() ? ["webm", "mp4"] : ["webm"];
        const formatLabels = { webm: "WEBM", mp4: "MP4" };
        formats.forEach((format) => {
            const option = document.createElement("option");
            option.value = format;
            option.text = formatLabels[format];
            this.formatSelect.appendChild(option);
        });
        this.formatSelect.style.width = "80px";
        this.formatSelect.addEventListener("change", formatSelectChange, { signal });

        this.playButton = this.#createButton("Play", playButtonClick, "70px");
        this.playButton.classList.add("sv-play");

        this.stepBackButton = this.#createButton(
            "←",
            stepBackButtonClick,
            "40px"
        );

        this.stepForwardButton = this.#createButton(
            "→",
            stepForwardButtonClick,
            "40px"
        );

        // Episode navigation. Hidden entirely for a non-episodic scene (the
        // common case) rather than shown disabled -- see #refreshEpisodeUI.
        this.prevEpisodeButton = this.#createButton(
            "|◀",
            prevEpisodeButtonClick,
            "40px"
        );
        this.prevEpisodeButton.title = "Previous episode ([)";
        this.nextEpisodeButton = this.#createButton(
            "▶|",
            nextEpisodeButtonClick,
            "40px"
        );
        this.nextEpisodeButton.title = "Next episode (])";
        this.episodeLabelSpan = document.createElement("span");
        this.episodeLabelSpan.className = "sv-readout";

        this.speedSelect = document.createElement("select");
        [0.1, 0.25, 0.5, 1, 2, 5].forEach((speed) => {
            const option = document.createElement("option");
            option.value = speed;
            option.text = `${speed}x`;
            if (speed === 1) option.selected = true;
            this.speedSelect.appendChild(option);
        });
        this.speedSelect.style.width = "70px";
        this.speedSelect.addEventListener("change", speedSelectChange, { signal });

        this.frameCounter = document.createElement("span");
        this.frameCounter.className = "sv-readout";

        this.progressBarContainer = document.createElement("div");
        this.progressBarContainer.className = "sv-progress";

        this.progressBar = document.createElement("div");
        this.progressBar.className = "sv-progress-fill";
        this.progressBarContainer.appendChild(this.progressBar);
        // Ticks live in their own overlay so redrawing them never disturbs the
        // progress fill, which updates every frame.
        this.episodeTicks = document.createElement("div");
        this.episodeTicks.className = "sv-progress-ticks";
        this.progressBarContainer.appendChild(this.episodeTicks);
        this.progressBarContainer.addEventListener(
            "click",
            progressBarContainerClick,
            { signal }
        );

        // Recording/screenshot controls share a wrapper so viewerDefaults.panels
        // (`recording: false`) / `#hide=recording` can hide them as one panel.
        this.recordingGroup = document.createElement("span");
        this.recordingGroup.className = "sv-playback-recording";
        [this.recordButton, this.formatSelect, this.screenshotButton].forEach((element) =>
            this.recordingGroup.appendChild(element)
        );

        // Assemble controls row
        [
            this.recordingGroup,
            this.stepBackButton,
            this.playButton,
            this.stepForwardButton,
            this.prevEpisodeButton,
            this.nextEpisodeButton,
            this.speedSelect,
            this.frameCounter,
            this.episodeLabelSpan,
        ].forEach((element) => this.controlsRow.appendChild(element));

        this.container.appendChild(this.controlsRow);
        this.container.appendChild(this.progressBarContainer);
        document.body.appendChild(this.container);

        document.addEventListener("keydown", keydownListener, { signal });

        this.#refreshEpisodeUI();
        this.updateElements();
    }

    // Called by SimView once the model is known, and again whenever live mode
    // pushes updated boundaries mid-run (see the onmessage handler there).
    setEpisodes(rawEpisodes) {
        this.rawEpisodes = rawEpisodes;
        this.refreshEpisodes();
    }

    // Re-normalizes against the current frame count. Separate from
    // setEpisodes() because in live mode the timeline grows under a fixed
    // episode list, which moves every tick's position and can bring an
    // already-marked episode into range.
    refreshEpisodes() {
        const frameCount = this.animationController.store
            ? this.animationController.store.length
            : 0;
        this.episodes = normalizeEpisodes(this.rawEpisodes, frameCount);
        this.#refreshEpisodeUI();
    }

    #jumpToFrame(frameIndex) {
        if (frameIndex == null) return;
        this.animationController.pause();
        this.playButton.textContent = "Play";
        this.animationController.seekToIndex(frameIndex);
        this.animationController.forceRedrawStaticElements();
    }

    // Shows/hides the episode controls and redraws the boundary ticks. Cheap
    // enough to redo wholesale, since it only runs when the episode list (not
    // the playhead) changes.
    #refreshEpisodeUI() {
        const hasEpisodes = this.episodes.length > 0;
        const display = hasEpisodes ? "inline-flex" : "none";
        this.prevEpisodeButton.style.display = display;
        this.nextEpisodeButton.style.display = display;
        this.episodeLabelSpan.style.display = hasEpisodes ? "flex" : "none";

        this.episodeTicks.replaceChildren();
        if (!hasEpisodes) return;

        const frameCount = this.animationController.store
            ? this.animationController.store.length
            : 0;
        if (frameCount <= 1) return;
        for (const episode of this.episodes) {
            // Frame 0 is the timeline's own start, not a visible boundary.
            if (episode.startIndex === 0) continue;
            const tick = document.createElement("div");
            tick.className = "sv-episode-tick";
            tick.style.left = `${(episode.startIndex / (frameCount - 1)) * 100}%`;
            this.episodeTicks.appendChild(tick);
        }
        // updateElements() only runs on a playback tick, so a scene sitting
        // paused right after load would otherwise show an empty label until
        // the user pressed play.
        this.#updateEpisodeLabel();
    }

    #updateEpisodeLabel() {
        if (this.episodes.length === 0) {
            this.episodeLabelSpan.textContent = "";
            return;
        }
        const frameIndex = this.animationController.getCurrentStateIndex();
        const index = episodeIndexAt(this.episodes, frameIndex);
        const segments = episodeSegments(
            this.episodes,
            this.animationController.store ? this.animationController.store.length : 0
        );
        const segment = segments.find((s) => s.index === index);
        this.episodeLabelSpan.textContent = segment ? `| ${episodeLabel(segment)}` : "";
    }

    updateElements() {
        // Elapsed since the first frame, so a timeline starting at t=100 still
        // reads 0.00 at its start and fills the bar from the left.
        const ac = this.animationController;
        const elapsed = ac.getCurrentTime() - ac.getFirstTime();
        const totalTime = ac.getTotalTime();
        this.frameCounter.textContent = `${elapsed.toFixed(2)} / ${totalTime.toFixed(2)} s`;
        const progress = totalTime > 0 ? elapsed / totalTime : 0;
        this.progressBar.style.width = `${(progress * 100).toFixed(1)}%`;
        this.#updateEpisodeLabel();
        this.lastRenderTime = Number.NEGATIVE_INFINITY;
    }

    animate(now) {
        if (now - this.lastRenderTime < this.minRenderDelay) return;
        this.updateElements();
        this.lastRenderTime = now;
    }

    dispose() {
        this.container.remove();
        this.abortController.abort();
    }

    // Fixed widths keep the row from shifting when a label toggles
    // (Play/Pause, REC/STOP); everything else is styled by .sv-playback.
    #createButton(text, onClick, width = "auto") {
        const button = document.createElement("button");
        button.style.width = width;
        button.textContent = text;
        button.addEventListener("click", onClick, {
            signal: this.abortController.signal,
        });
        return button;
    }
}
