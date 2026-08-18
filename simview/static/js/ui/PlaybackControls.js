import { FREQ_CONFIG } from "../config.js";
import { isMp4RecordingSupported } from "../components/AnimationController.js";
import {
    episodeIndexAt,
    episodeLabel,
    episodeSegments,
    nextEpisodeStart,
    normalizeEpisodes,
    previousEpisodeStart,
} from "../utils/episodes.js";

const buttonHeight = 25;
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
        Object.assign(this.container.style, {
            position: "absolute",
            bottom: "20px",
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "5px",
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            padding: "10px 20px",
            borderRadius: "5px",
        });

        this.controlsRow = document.createElement("div");
        Object.assign(this.controlsRow.style, {
            display: "flex",
            alignItems: "center",
            flexDirection: "row",
            gap: "15px",
        });

        // **Cache listener functions**
        this.recordButtonClick = () => {
            if (this.animationController.isRecording) {
                this.animationController.stopRecording();
                this.recordButton.textContent = "⚫ REC";
                this.recordButton.style.backgroundColor = "#444";
            } else {
                this.animationController.startRecording();
                this.recordButton.textContent = "⬛ STOP";
                this.recordButton.style.backgroundColor = "#aa0000";
            }
        };

        this.formatSelectChange = (e) => {
            this.animationController.setRecordingFormat(e.target.value);
        };

        this.screenshotButtonClick = () => {
            this.animationController.captureScreenshot();
        };

        this.playButtonClick = () => {
            if (this.animationController.isPlaying) {
                this.animationController.pause();
                this.playButton.textContent = "Play";
            } else {
                this.animationController.play();
                this.playButton.textContent = "Pause";
            }
        };

        this.stepBackButtonClick = () => {
            this.animationController.pause();
            this.animationController.stepBackward();
            this.playButton.textContent = "Play";
        };

        this.stepForwardButtonClick = () => {
            this.animationController.pause();
            this.animationController.stepForward();
            this.playButton.textContent = "Play";
        };

        this.speedSelectChange = (e) => {
            console.debug("Speed changed to", e.target.value);
            this.animationController.setSpeed(parseFloat(e.target.value));
        };

        this.prevEpisodeButtonClick = () => {
            this.#jumpToFrame(
                previousEpisodeStart(
                    this.episodes,
                    this.animationController.getCurrentStateIndex()
                )
            );
        };

        this.nextEpisodeButtonClick = () => {
            this.#jumpToFrame(
                nextEpisodeStart(
                    this.episodes,
                    this.animationController.getCurrentStateIndex()
                )
            );
        };

        this.progressBarContainerClick = (event) => {
            const rect = this.progressBarContainer.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const progress = x / rect.width;
            const targetTime = progress * this.animationController.getTotalTime();

            if (event.altKey) {
                this.animationController.pause();
                this.playButton.textContent = "Play";
            }
            this.animationController.goToTime(targetTime);
        };

        this.keydownListener = (event) => {
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
                    this.recordButton.click();
                    break;
                case "s":
                    this.screenshotButton.click();
                    break;
                case " ":
                    this.playButton.click();
                    event.target.blur();
                    break;
            }
        };

        // **Create elements and attach cached listeners**
        this.recordButton = this.#createButton(
            "⚫ REC",
            this.recordButtonClick,
            "100px"
        );

        this.screenshotButton = this.#createButton(
            "📷",
            this.screenshotButtonClick,
            "40px"
        );
        this.screenshotButton.title = "Screenshot (S)";

        this.formatSelect = document.createElement("select");
        // "mp4" is only offered when this browser's MediaRecorder can
        // actually produce it (see isMp4RecordingSupported) -- webm is
        // always available wherever MediaRecorder is, so it's the
        // unconditional default/fallback.
        const formats = isMp4RecordingSupported() ? ["webm", "mp4", "png"] : ["webm", "png"];
        const formatLabels = { webm: "WEBM", mp4: "MP4", png: "PNG" };
        formats.forEach((format) => {
            const option = document.createElement("option");
            option.value = format;
            option.text = formatLabels[format];
            this.formatSelect.appendChild(option);
        });
        Object.assign(this.formatSelect.style, {
            width: "100px",
            textAlign: "center",
            height: buttonHeight + "px",
        });
        this.formatSelect.addEventListener("change", this.formatSelectChange);

        this.playButton = this.#createButton("Play", this.playButtonClick, "70px");

        this.stepBackButton = this.#createButton(
            "←",
            this.stepBackButtonClick,
            "40px"
        );

        this.stepForwardButton = this.#createButton(
            "→",
            this.stepForwardButtonClick,
            "40px"
        );

        // Episode navigation. Hidden entirely for a non-episodic scene (the
        // common case) rather than shown disabled -- see #refreshEpisodeUI.
        this.prevEpisodeButton = this.#createButton(
            "|◀",
            this.prevEpisodeButtonClick,
            "40px"
        );
        this.prevEpisodeButton.title = "Previous episode ([)";
        this.nextEpisodeButton = this.#createButton(
            "▶|",
            this.nextEpisodeButtonClick,
            "40px"
        );
        this.nextEpisodeButton.title = "Next episode (])";
        this.episodeLabelSpan = document.createElement("span");
        Object.assign(this.episodeLabelSpan.style, {
            color: "white",
            display: "none",
            alignItems: "center",
            height: "30px",
            fontFamily: "monospace",
            whiteSpace: "nowrap",
        });

        this.speedSelect = document.createElement("select");
        [0.1, 0.25, 0.5, 1, 2, 5].forEach((speed) => {
            const option = document.createElement("option");
            option.value = speed;
            option.text = `${speed}x`;
            if (speed === 1) option.selected = true;
            this.speedSelect.appendChild(option);
        });
        Object.assign(this.speedSelect.style, {
            width: "80px",
            textAlign: "center",
            height: buttonHeight + "px",
        });
        this.speedSelect.addEventListener("change", this.speedSelectChange);

        this.frameCounter = document.createElement("span");
        Object.assign(this.frameCounter.style, {
            color: "white",
            display: "flex",
            alignItems: "center",
            height: "30px",
            marginLeft: "5px",
            fontFamily: "monospace",
        });

        this.progressBarContainer = document.createElement("div");
        Object.assign(this.progressBarContainer.style, {
            width: "100%",
            marginLeft: "15px",
            marginRight: "15px",
            // `relative` so the absolutely-positioned episode ticks below are
            // placed against the bar rather than the page.
            position: "relative",
            height: "8px",
            backgroundColor: "#222",
            borderRadius: "4px",
            cursor: "pointer",
            marginTop: "5px",
        });

        this.progressBar = document.createElement("div");
        Object.assign(this.progressBar.style, {
            width: "0%",
            height: "100%",
            backgroundColor: "#888",
            borderRadius: "4px",
        });
        this.progressBarContainer.appendChild(this.progressBar);
        // Ticks live in their own overlay so redrawing them never disturbs the
        // progress fill, which updates every frame.
        this.episodeTicks = document.createElement("div");
        Object.assign(this.episodeTicks.style, {
            position: "absolute",
            inset: "0",
            pointerEvents: "none",
        });
        this.progressBarContainer.appendChild(this.episodeTicks);
        this.progressBarContainer.addEventListener(
            "click",
            this.progressBarContainerClick
        );

        // Assemble controls row
        [
            this.recordButton,
            this.formatSelect,
            this.screenshotButton,
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

        // Attach document-level listener
        document.addEventListener("keydown", this.keydownListener);

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
        this.forceRedraw();
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
            Object.assign(tick.style, {
                position: "absolute",
                top: "0",
                bottom: "0",
                width: "2px",
                marginLeft: "-1px",
                backgroundColor: "rgba(255, 255, 255, 0.75)",
                left: `${(episode.startIndex / (frameCount - 1)) * 100}%`,
            });
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
        const currentTime = this.animationController.getCurrentTime().toFixed(3);
        const totalTime = this.animationController.getTotalTime().toFixed(3);
        this.frameCounter.textContent = `time: ${currentTime} / ${totalTime}`;
        const progress = currentTime / totalTime;
        this.progressBar.style.width = `${(progress * 100).toFixed(1)}%`;
        this.#updateEpisodeLabel();
        this.lastRenderTime = Number.NEGATIVE_INFINITY;
    }

    forceRedraw() {
        this.updateElements();
        this.lastRenderTime = Number.NEGATIVE_INFINITY;
    }

    animate(now) {
        if (now - this.lastRenderTime < this.minRenderDelay) return;
        this.updateElements();
        this.lastRenderTime = now;
    }

    dispose() {
        // Remove the container from the DOM
        this.container.remove();

        // Remove all event listeners using cached functions
        this.recordButton.removeEventListener("click", this.recordButtonClick);
        this.formatSelect.removeEventListener("change", this.formatSelectChange);
        this.screenshotButton.removeEventListener("click", this.screenshotButtonClick);
        this.playButton.removeEventListener("click", this.playButtonClick);
        this.stepBackButton.removeEventListener("click", this.stepBackButtonClick);
        this.stepForwardButton.removeEventListener(
            "click",
            this.stepForwardButtonClick
        );
        this.prevEpisodeButton.removeEventListener(
            "click",
            this.prevEpisodeButtonClick
        );
        this.nextEpisodeButton.removeEventListener(
            "click",
            this.nextEpisodeButtonClick
        );
        this.speedSelect.removeEventListener("change", this.speedSelectChange);
        this.progressBarContainer.removeEventListener(
            "click",
            this.progressBarContainerClick
        );
        document.removeEventListener("keydown", this.keydownListener);
    }

    #createButton(text, onClick, width = "auto") {
        const button = document.createElement("button");
        Object.assign(button.style, {
            padding: "5px 5px",
            backgroundColor: "#444",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            width: width,
            minWidth: "40px",
            height: buttonHeight + "px",
            display: "inline-flex",
            justifyContent: "center",
            alignItems: "center",
        });
        button.textContent = text;
        button.addEventListener("click", onClick);
        return button;
    }
}
