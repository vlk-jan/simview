import * as THREE from "three";
import { Scene } from "./components/Scene.js";
import { UIControls } from "./ui/Controls.js";
import { BodyStateWindow } from "./ui/BodyStateWindow.js";
import { AnimationController } from "./components/AnimationController.js";
import { UI_DEFAULT_CONFIG } from "./config.js";
import { Body } from "./objects/Body.js";
import { Terrain } from "./objects/Terrain.js";
import { BatchManager } from "./components/BatchManager.js";
import { ScalarPlotter } from "./ui/ScalarPlotter.js";
import { StaticObject } from "./objects/StaticObject.js";
import { Legend } from "./ui/Legend.js";
import { BatchLegend } from "./ui/BatchLegend.js";
import { ErrorMetrics } from "./ui/ErrorMetrics.js";
import { TerrainProfile } from "./ui/TerrainProfile.js";
import { AnalysisPanel } from "./ui/AnalysisPanel.js";
import { InteractionController } from "./components/InteractionController.js";
import { buildBodyMeta, resolveStateBodies, topoSortBodies } from "./utils/bodyTransforms.js";
import { hasBodyTrajectory } from "./utils/terrainSample.js";
import {
    decodeFloat32Blob,
    decodeStateField,
    decodeStatesChunk,
    STATE_FIELD_WIDTHS,
} from "./utils/blobCodec.js";
import { StateStore } from "./components/StateStore.js";
import { WindowedField } from "./components/WindowedField.js";
import { bytesPerFrame, shouldWindowField } from "./utils/blobWindow.js";
import { shouldFollowLive } from "./utils/liveFollow.js";
import { parseViewState } from "./utils/viewState.js";

export class SimView {
    constructor() {
        this.scene = null;
        this.uiControls = null;
        this.bodyStateWindow = null;
        this.animationController = null;
        this.scalarPlotter = null;
        this.errorMetrics = null;
        this.terrainProfile = null;
        this.analysisPanel = null;
        this.legend = null;
        this.batchLegend = null;
        this.batchManager = null;
        this.interactionController = null;
        this.terrain = null;
        this.bodies = null;
        this.staticObjects = null;
        this.uiState = structuredClone(UI_DEFAULT_CONFIG);
        this.animate = this.animate.bind(this);
        // Live streaming mode (see startLiveStream): the open WebSocket (or
        // null once closed/if never opened) and its "LIVE" badge element.
        this.liveSocket = null;
        this.liveBadge = null;
        // Static demo mode: when window.__simviewStaticBase is set by the
        // GitHub Pages demo index.html, all data fetches are redirected to
        // flat static files (model.json, states.json, blob/N) instead of the
        // Python backend API endpoints. Set to null in normal server mode.
        this.staticBase = null;
    }

    static run() {
        const simView = new SimView();
        // Static demo mode: the CI-generated index.html sets
        // window.__simviewStaticBase = "." before this module loads so the
        // viewer knows to fetch pre-dumped flat files instead of hitting the
        // live Python backend.
        if (typeof window.__simviewStaticBase === "string") {
            simView.staticBase = window.__simviewStaticBase;
            console.log(`SimView: static demo mode, base='${simView.staticBase}'`);
        }
        window.__debugSimView = simView;
        simView.initAndAnimate();
    }

    // Fetch the model and states over HTTP (both served pre-gzipped by the server,
    // transparently decompressed by the browser) and build the scene from them.
    // In static demo mode (this.staticBase non-null) the same paths are
    // redirected to pre-dumped flat files: model.json, states.json, blob/N.
    async loadData() {
        const splash = document.getElementById("loading-splash");
        const base = this.staticBase;
        try {
            if (splash) splash.innerHTML = "<h1>Loading Model (HTTP)...</h1>";
            console.time("fetch_model");
            const modelResponse = await fetch(base ? `${base}/model.json` : "/model");
            console.timeEnd("fetch_model");
            if (!modelResponse.ok)
                throw new Error(`Failed to fetch model: ${modelResponse.status} ${modelResponse.statusText}`);

            if (splash) splash.innerHTML = "<h1>Parsing Model JSON...</h1>";
            console.time("parse_model");
            const model = await modelResponse.json();
            console.timeEnd("parse_model");

            console.time("fetch_blobs");
            await this.fetchBlobs(model);
            console.timeEnd("fetch_blobs");

            console.log("Model received, initializing components...");
            this.initFromModel(model);

            if (splash) splash.innerHTML = "<h1>Loading States (HTTP)...</h1>";
            console.time("fetch_states");
            const statesResponse = await fetch(base ? `${base}/states.json` : "/states");
            console.timeEnd("fetch_states");
            if (!statesResponse.ok)
                throw new Error(`Failed to fetch states: ${statesResponse.status} ${statesResponse.statusText}`);

            console.time("parse_states");
            const statesPayload = await statesResponse.json();
            console.timeEnd("parse_states");

            if (Array.isArray(statesPayload)) {
                // Legacy wire shape: a plain per-frame array, possibly with
                // inline __b64__ fields to expand.
                console.debug(`Received ${statesPayload.length} states (legacy)`);
                this.processStates(statesPayload);
            } else if (statesPayload && statesPayload.live === true) {
                // Live streaming mode (see simview.live.LiveViewer): no states
                // yet, they arrive incrementally over /ws/states instead.
                console.debug("Live mode: opening /ws/states");
                this.store = StateStore.fromLegacy([]);
                this.startLiveStream(splash);
            } else if (statesPayload && statesPayload.version === 4) {
                // Columnar wire shape (see server.py::_columnarize_states):
                // a lightweight index plus /blob/... URLs for the actual
                // whole-trajectory float32 data, fetched in parallel below.
                console.debug(`Received ${statesPayload.times.length} states (columnar)`);
                // Long trajectories: swap the biggest current-frame-only
                // fields for windowed readers before the bulk fetch, so they
                // are never materialized in full (see utils/blobWindow.js).
                this.windowLargeStateFields(statesPayload);
                console.time("fetch_state_blobs");
                await this.fetchBlobs(statesPayload);
                console.timeEnd("fetch_state_blobs");
                this.store = StateStore.fromColumnar(statesPayload, this.batchManager.simBatches);
                this.onStoreReady();
            } else {
                throw new Error("Unrecognized /states payload shape");
            }

            // Live mode keeps the splash up (repurposed as a "waiting for
            // first state" indicator by startLiveStream) until the first
            // frame actually arrives -- see the onmessage handler there.
            if (splash && !this.liveSocket) splash.remove();
            console.log("Initialization complete!");
        } catch (error) {
            console.error("Critical error during initial data fetch:", error);
            if (splash) {
                splash.innerHTML = `<h1 style="color: red;">Load Error</h1><p>${error.message}</p><p>Check browser console for details.</p>`;
            }
            throw error;
        }
    }

    // Replaces the blob URL of every large, current-frame-only per-body field
    // with a WindowedField, so fetchBlobs skips it and it's read in windows
    // around the playhead instead. Static demo mode is excluded: it serves
    // pre-dumped flat files with no Range support.
    //
    // bodyTransform, contacts and the scalars are deliberately untouched --
    // trails, error metrics, the terrain profile and the scalar plots all walk
    // the whole trajectory, so windowing those would just move the cost.
    windowLargeStateFields(statesPayload) {
        if (this.staticBase) return;
        const totalFrames = statesPayload.times.length;
        const batchCount = this.batchManager.simBatches;
        // Overridable so tests can exercise windowing without a fixture big
        // enough to cross the real threshold (same spirit as
        // window.__debugSimView); undefined in normal use.
        const threshold = window.__simviewWindowThresholdBytes;

        let windowed = 0;
        for (const body of statesPayload.bodies || []) {
            for (const field of Object.keys(body.fields || {})) {
                const url = body.fields[field];
                const width = STATE_FIELD_WIDTHS[field];
                if (typeof url !== "string" || !width) continue;
                const totalBytes = totalFrames * bytesPerFrame(batchCount, width);
                if (!shouldWindowField(field, totalBytes, threshold)) continue;

                body.fields[field] = new WindowedField(url, {
                    totalFrames,
                    batchCount,
                    width,
                });
                windowed++;
            }
        }
        if (windowed > 0) {
            console.log(
                `Windowing ${windowed} large state field(s) instead of loading them in full.`
            );
        }
    }

    // Walks any JSON-shaped object/array (the model, or the columnar states
    // payload) collecting every "/blob/..." reference, then fetches them all
    // in parallel and replaces each in place with its decoded Float32Array --
    // sequential awaits here would serialize what's otherwise an
    // embarrassingly parallel set of independent HTTP requests.
    //
    // In static demo mode (this.staticBase non-null), blob URLs are rewritten
    // from /blob/{token}/{id} → {staticBase}/blob/{id} so they resolve against
    // the pre-dumped flat files deployed alongside the demo page.
    async fetchBlobs(obj) {
        const base = this.staticBase;
        const refs = [];
        const collect = (node) => {
            if (!node || typeof node !== 'object') return;
            // A WindowedField holds its own blob URL and fetches ranges of it
            // itself -- recursing in would "helpfully" replace that URL with
            // the very full-blob download the windowing exists to avoid.
            if (node instanceof WindowedField) return;
            for (const key of Object.keys(node)) {
                const val = node[key];
                if (typeof val === 'string' && val.startsWith('/blob/')) {
                    // Static mode: /blob/{token}/{id} → {base}/blob/{id}
                    const url = base
                        ? `${base}/blob/${val.split("/").pop()}`
                        : val;
                    refs.push({ container: node, key, url });
                } else if (typeof val === 'object') {
                    collect(val);
                }
            }
        };
        collect(obj);

        await Promise.all(
            refs.map(async ({ container, key, url }) => {
                const res = await fetch(url);
                // Without this check a 404/500 body (an error page) would be
                // silently reinterpreted as float32 data, corrupting whatever
                // geometry/trajectory referenced this blob.
                if (!res.ok) {
                    throw new Error(`Failed to fetch blob ${url}: ${res.status} ${res.statusText}`);
                }
                const arrayBuffer = await res.arrayBuffer();
                container[key] = SimView.decodeFloat32Blob(arrayBuffer);
            })
        );
    }

    // Opens the live-streaming WebSocket (see simview.live.LiveViewer): each
    // message is `{states: [<frame>, ...]}` -- one catch-up message with
    // every frame buffered so far, then one message per subsequently pushed
    // frame -- and is run through the same processStatesChunk path the
    // static per-frame legacy wire shape uses. `splash` (the loading-splash
    // element, already repurposed as a "waiting for first state" message by
    // the caller) is removed once the first frame actually arrives.
    startLiveStream(splash) {
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(`${protocol}//${location.host}/ws/states`);
        this.liveSocket = socket;
        this.showLiveBadge();

        socket.onmessage = (event) => {
            const message = JSON.parse(event.data);
            // Two message kinds share this socket: batches of new frames, and
            // (far more rarely) updated episode boundaries when the producer
            // calls LiveViewer.mark_episode mid-run.
            if (message.episodes) {
                this.applyEpisodes(message.episodes);
                return;
            }
            const { states } = message;
            if (!states || states.length === 0) return;
            this.processStatesChunk(states);
            if (splash) splash.remove();
        };
        socket.onclose = () => {
            console.log("Live stream closed (simulation finished serving).");
            this.liveSocket = null;
            this.hideLiveBadge();
        };
        socket.onerror = (event) => {
            console.error("Live stream error:", event);
        };
    }

    // Hands episode boundaries to the consumers that visualize them. Safe to
    // call before the playback controls exist (they're built with the store),
    // since onStoreReady calls it again once they do.
    applyEpisodes(episodes) {
        this.episodes = Array.isArray(episodes) ? episodes : [];
        const controls = this.animationController?.playbackControls;
        if (controls) controls.setEpisodes(this.episodes);
        if (this.scalarPlotter) this.scalarPlotter.setEpisodes(this.episodes);
    }

    showLiveBadge() {
        if (this.liveBadge) return;
        const badge = document.createElement("div");
        badge.textContent = "LIVE";
        Object.assign(badge.style, {
            position: "absolute",
            bottom: "20px",
            right: "20px",
            padding: "4px 10px",
            borderRadius: "4px",
            backgroundColor: "rgba(200, 0, 0, 0.8)",
            color: "white",
            fontFamily: "monospace",
            fontWeight: "bold",
            letterSpacing: "1px",
            zIndex: 1000,
        });
        document.body.appendChild(badge);
        this.liveBadge = badge;
    }

    hideLiveBadge() {
        if (this.liveBadge) {
            this.liveBadge.remove();
            this.liveBadge = null;
        }
    }

    // Thin delegates to utils/blobCodec.js -- kept as methods since other code
    // calls through `this`/`SimView.*` and the pure decoding logic lives there
    // so it can be unit-tested without a SimView instance.
    static decodeFloat32Blob(arrayBuffer) {
        return decodeFloat32Blob(arrayBuffer);
    }

    static STATE_FIELD_WIDTHS = STATE_FIELD_WIDTHS;

    decodeStateField(str, width) {
        return decodeStateField(str, width);
    }

    decodeStatesChunk(chunk) {
        decodeStatesChunk(chunk);
    }

    // Legacy wire shape entry point: decodes any inline __b64__ fields, wraps
    // the array in a LegacyStateStore, and (dis)patches it exactly like the
    // columnar path below via onStoreReady.
    //
    // Branches on whether the animation has been loaded yet (not on whether
    // `this.store` exists) so the live-streaming path works too: there
    // `this.store` is created empty up front (see startLiveStream), and the
    // first inbound chunk must still go through the "first load" branch
    // (loadAnimation/initFromStore) rather than being treated as an append to
    // an already-running animation.
    processStatesChunk(chunk) {
        this.decodeStatesChunk(chunk);
        const firstLoad = !this.animationController || !this.animationController.store;
        if (!this.store) {
            this.store = StateStore.fromLegacy(chunk);
        } else if (firstLoad) {
            this.store.append(chunk);
        } else {
            const wasFollowingLive = shouldFollowLive(this.animationController);
            const startIndex = this.store.append(chunk);
            this.animationController.onStatesAppended();
            this.appendBodyHistories(startIndex);
            if (this.errorMetrics) {
                this.errorMetrics.onHistoryReady();
            }
            if (wasFollowingLive) {
                this.animationController.goToTime(this.store.lastTime());
            }
        }
        if (firstLoad) {
            this.onStoreReady();
        }
    }

    // Called once the store (legacy or columnar) has its full initial
    // timeline available -- wires it into the animation/scalar/history
    // consumers that were previously handed the raw states array directly.
    onStoreReady() {
        if (this.animationController) {
            this.animationController.loadAnimation(this.store);
            // loadAnimation builds the PlaybackControls, so episodes can only
            // be handed over afterwards.
            this.applyEpisodes(this.episodes);
            if (this.scalarPlotter) {
                this.scalarPlotter.initFromStore(this.store);
            }
        }
        this.appendBodyHistories(0);
        // Whether a point-cloud body is listed depends on whether it turned
        // out to carry per-frame data, which is only knowable now that
        // appendBodyHistories has run (see BodyStateWindow.updateBodyList).
        if (this.bodyStateWindow) this.bodyStateWindow.updateBodyList();
        if (this.errorMetrics) {
            this.errorMetrics.onHistoryReady();
        }
        this.maybeAttachTerrainProfile();
    }

    // Terrain tab needs an actual body *path* to sample terrain along, not
    // just a body existing (a static point cloud with no states, e.g. a
    // WaffleIron feature-similarity export, is a body with terrain but
    // nothing to plot a profile against). Only knowable here, after
    // appendBodyHistories() has populated each body's validStates -- doing
    // this check at initFromModel() time (before states are even fetched)
    // showed the tab unconditionally whenever a scene had terrain + any
    // body, trajectory or not.
    maybeAttachTerrainProfile() {
        if (!this.terrain || this.terrainProfile) return;
        if (!hasBodyTrajectory(this.bodies)) return;
        if (!this.analysisPanel) {
            this.analysisPanel = new AnalysisPanel(this);
        }
        this.terrainProfile = new TerrainProfile(this);
        this.analysisPanel.attachTerrainProfile(this.terrainProfile);
    }

    // Resolves and records position/orientation (and contacts, vectors, ...)
    // history for every frame from `startIndex` to the end of the store, for
    // trails and the error metrics panel. Each frame is materialized
    // transiently via store.getFrame(i) (not retained) so this works
    // identically whether the store is legacy or columnar.
    appendBodyHistories(startIndex) {
        if (!this.bodies || this.bodies.size === 0) return;
        for (let s = startIndex; s < this.store.length; s++) {
            const bodyStates = this.store.getFrame(s).bodies;
            if (!bodyStates) continue;
            // Resolve off this historical state's own data (not any Body's
            // current/live pose, which reflects whatever frame is currently
            // displayed) -- a child's parent pose must come from the same
            // state index `s` being appended here.
            const resolved = resolveStateBodies(
                this.bodyMeta,
                this.bodyTopoOrder,
                this.batchManager.simBatches,
                bodyStates
            );
            resolved.forEach((resolvedBodyState, name) => {
                const body = this.bodies.get(name);
                if (body) {
                    if (body.appendHistoryPointAt) {
                        body.appendHistoryPointAt(s, resolvedBodyState);
                    } else if (body.setHistoryPointAt) {
                        body.setHistoryPointAt(s, resolvedBodyState);
                    }
                }
            });
        }
        this.bodies.forEach((body) => {
            if (body.finalizeTrails) body.finalizeTrails();
        });
    }

    processStates(statesData) {
        this.processStatesChunk(statesData);
    }

    initFromModel(model) {
        try {
            this.disposeOfAll();

            // Free-form run provenance carried through from the Python side
            // (see SimViewModel.metadata) -- no meaning to the viewer itself,
            // just displayed read-only in the "Scene Info" GUI folder.
            this.metadata = model.metadata ?? null;

            // Episode boundaries for an episodic (RL) recording, applied to
            // the playback bar once the store exists (see onStoreReady).
            // Absent for an ordinary single-timeline scene.
            this.episodes = Array.isArray(model.episodes) ? model.episodes : [];

            this.batchManager = new BatchManager(this, model);
            this.bodies = new Map();

            // Auto-detect visualization mode from the first body the mode
            // actually governs: anything with a real surface
            // (box/sphere/cylinder/mesh) defaults to mesh. Point clouds are
            // skipped rather than inspected -- they're outside the mode
            // entirely (see Body#pointsVisible), and model.bodies[0] being a
            // cloud must not leave a scene full of meshes defaulting to a
            // mode that renders none of them.
            if (Array.isArray(model.bodies) && model.bodies.length > 0) {
                const firstSolid = model.bodies.find(
                    (b) => b.shape && b.shape.type !== "pointcloud"
                );
                if (firstSolid) {
                    console.log("Auto-switching visualization mode to 'mesh' based on body type");
                    this.uiState.bodyVisualizationMode = "mesh";
                }
            }

            if (Array.isArray(model.bodies)) {
                model.bodies.forEach((bodyData) => {
                    const body = new Body(bodyData, this);
                    this.bodies.set(bodyData.name, body);
                    this.scene.addObject3D(body.getObject3D());
                });
            }
            // Parent-relative transforms (rigid/articulated attachments, see
            // README.md): resolved once here so per-frame/per-state consumers
            // below only ever deal with ordinary absolute-world transforms.
            this.bodyMeta = buildBodyMeta(model.bodies);
            this.bodyTopoOrder = topoSortBodies(this.bodyMeta);
            if (Array.isArray(model.staticObjects)) {
                this.staticObjects = model.staticObjects.map((staticObjectData) => {
                    const staticObject = new StaticObject(staticObjectData, this);
                    this.scene.addObject3D(staticObject.getObject3D());
                    return staticObject;
                });
            }
            if (model.terrain) {
                console.debug("Using terrain data");
                this.terrain = new Terrain(model.terrain, this);
                this.scene.addObject3D(this.terrain.getObject3D());
                // Terrain extent is what tells us how far this scene reaches,
                // so the camera's clipping/orbit range can stop being a guess.
                this.scene.applySceneExtent(this.terrain.bounds);
            } else {
                throw new Error("Terrain data is missing in model");
            }
            const hasScalars = model.scalarNames && model.scalarNames.length > 0;
            const hasErrorMetrics = this.batchManager.simBatches >= 2;
            // Terrain tab needs an actual body *path* to sample against -- not
            // just a body existing, a body with real trajectory data -- which
            // isn't known yet at this point (states haven't been fetched;
            // that happens after initFromModel returns, see loadData()).
            // Deferred to onStoreReady(), once appendBodyHistories() has run
            // and each body's validStates reflects what it actually got.
            if (hasScalars || hasErrorMetrics) {
                this.analysisPanel = new AnalysisPanel(this);
            }
            if (hasScalars) {
                console.debug(
                    "Initializing scalar plotter for scalars",
                    model.scalarNames
                );
                this.scalarPlotter = new ScalarPlotter(this, model.scalarNames);
                this.analysisPanel.attachScalarPlotter(this.scalarPlotter);
            }
            if (hasErrorMetrics) {
                this.errorMetrics = new ErrorMetrics(this);
                this.analysisPanel.attachErrorMetrics(this.errorMetrics);
            }
            this.interactionController = new InteractionController(this);
            this.uiControls = new UIControls(this);
            this.bodyStateWindow = new BodyStateWindow(this);
            this.legend = new Legend(this);
            if (this.batchManager.simBatches >= 2) {
                this.batchLegend = new BatchLegend(this);
            }
            this.animationController = new AnimationController(this, model.dt);
        } catch (error) {
            console.error("Error during initFromModel:", error);
            const splash = document.getElementById("loading-splash");
            if (splash) {
                splash.innerHTML = `<h1 style="color: red;">Error during initialization</h1><p>${error.message}</p>`;
            }
            throw error;
        }
    }

    async initAndAnimate() {
        try {
            this.scene = new Scene(this);
            await this.loadData();
            this.applyViewStateFromHash();
            this.animate();
            const splash = document.getElementById("loading-splash");
            if (splash) splash.remove();
        } catch (error) {
            console.error("Initialization failed:", error);
            const splash = document.getElementById("loading-splash");
            if (splash) {
                splash.innerHTML = `<h1 style="color: red;">Failed to connect or initialize</h1><p>${error.message}</p>`;
            }
        }
    }

    // Shareable-view-link apply-on-load (see utils/viewState.js and
    // ui/Controls.js's "Copy view link" button that produces these hashes).
    // Called once from initAndAnimate() right after loadData() resolves --
    // by then the animation/scene/uiControls are all fully wired (loadData
    // awaits through to onStoreReady/animationController.loadAnimation for
    // every non-live wire shape), so goToTime/camera/batch focus are all
    // safe to apply here. Live-streaming mode is the one case where
    // loadAnimation may not have run yet (see startLiveStream) -- there's no
    // timeline to seek yet, so this just skips silently rather than
    // crashing; the view link's toggles/camera still get applied via the
    // early-return guards below where possible.
    //
    // A malformed/missing hash (parseViewState returning null) or a bad
    // partial state must never break page load -- every step below is
    // independently guarded.
    applyViewStateFromHash() {
        let state;
        try {
            state = parseViewState(location.hash);
        } catch (e) {
            console.warn("Failed to parse view-state hash:", e);
            return;
        }
        if (!state) return;

        try {
            if (this.batchManager && Number.isInteger(state.batchIndex)) {
                this.batchManager.setActiveBatch(state.batchIndex);
            }

            if (this.animationController && this.animationController.store) {
                this.animationController.pause();
                if (Number.isFinite(state.time)) {
                    this.animationController.goToTime(state.time);
                }
            }

            if (this.scene && state.camera) {
                const { camera, controls } = this.scene;
                if (state.camera.position) {
                    camera.position.set(state.camera.position.x, state.camera.position.y, state.camera.position.z);
                }
                if (state.camera.target) {
                    controls.target.set(state.camera.target.x, state.camera.target.y, state.camera.target.z);
                }
                if (Number.isFinite(state.camera.fov)) {
                    camera.fov = state.camera.fov;
                    camera.updateProjectionMatrix();
                }
                controls.update();
            }

            // Routed through UIControls.applyViewState so lil-gui's own
            // controllers (and their onChange handlers, which is what
            // actually flips body/terrain visuals) stay in sync instead of
            // uiState silently drifting out from under the displayed panel.
            if (this.uiControls) {
                this.uiControls.applyViewState(state);
            }
        } catch (e) {
            console.warn("Failed to apply view state from URL hash:", e);
        }
    }

    disposeOfAll() {
        if (this.bodies) {
            for (const body of this.bodies.values()) {
                body.dispose();
            }
        }
        if (this.staticObjects) {
            for (const staticObject of this.staticObjects) {
                staticObject.dispose();
            }
        }
        if (this.terrain) {
            this.terrain.dispose();
        }
        if (this.uiControls) {
            this.uiControls.dispose();
        }
        if (this.animationController) {
            this.animationController.dispose();
        }
        if (this.scalarPlotter) {
            this.scalarPlotter.dispose();
            this.scalarPlotter = null;
        }
        if (this.errorMetrics) {
            this.errorMetrics.dispose();
            this.errorMetrics = null;
        }
        if (this.terrainProfile) {
            this.terrainProfile.dispose();
            this.terrainProfile = null;
        }
        if (this.analysisPanel) {
            this.analysisPanel.dispose();
            this.analysisPanel = null;
        }
        if (this.bodyStateWindow) {
            this.bodyStateWindow.dispose();
        }
        if (this.legend) {
            this.legend.dispose();
        }
        if (this.batchLegend) {
            this.batchLegend.dispose();
            this.batchLegend = null;
        }
        if (this.interactionController) {
            this.interactionController.cleanup();
            this.interactionController = null;
        }
    }

    animate() {
        requestAnimationFrame(this.animate);
        const now = performance.now();
        
        // 1. Update states and time
        if (this.animationController) {
            this.animationController.animate(now);
        }
        
        // 2. Update UI components
        if (this.scalarPlotter) {
            this.scalarPlotter.animate(now);
        }
        if (this.bodyStateWindow) {
            this.bodyStateWindow.animate(now);
        }
        if (this.errorMetrics) {
            this.errorMetrics.animate(now);
        }
        if (this.terrainProfile) {
            this.terrainProfile.animate(now);
        }

        // 3. Render the scene
        if (this.scene) {
            if (this.uiState && this.uiState.trackBody && this.uiState.trackBody !== "None") {
                const body = this.bodies.get(this.uiState.trackBody);
                if (body && this.batchManager) {
                    const activeBatch = this.batchManager.currentlyActiveBatch;
                    if (body.positions && body.positions[activeBatch]) {
                        const pos = body.positions[activeBatch];
                        const offset = this.batchManager.getBatchOffset(activeBatch);
                        const currentBodyPos = new THREE.Vector3(pos.x + offset.x, pos.y + offset.y, pos.z + offset.z);
                        
                        try {
                            if (this._lastTrackedBody !== this.uiState.trackBody) {
                                // On first tracking or switch, center the target on the body, preserving the viewing angle
                                const delta = currentBodyPos.clone().sub(this.scene.controls.target);
                                this.scene.camera.position.add(delta);
                                this.scene.controls.target.copy(currentBodyPos);
                                this.scene.controls.update();
                                console.log("Started tracking", this.uiState.trackBody);
                            } else if (this._lastTrackedPosition) {
                                // On subsequent frames, shift camera and target by the exact movement delta of the body
                                const delta = currentBodyPos.clone().sub(this._lastTrackedPosition);
                                // Only update if it actually moved
                                if (delta.lengthSq() > 0) {
                                    this.scene.camera.position.add(delta);
                                    this.scene.controls.target.add(delta);
                                    this.scene.controls.update();
                                }
                            }
                        } catch (e) {
                            console.error("Error in tracking logic:", e);
                        }
                        
                        this._lastTrackedBody = this.uiState.trackBody;
                        this._lastTrackedPosition = currentBodyPos.clone();
                    }
                }
            } else {
                this._lastTrackedBody = null;
                this._lastTrackedPosition = null;
            }
            this.scene.animate(now);
        }
        
        // 4. Capture the frame if recording
        if (this.animationController && this.animationController.isRecording) {
            this.animationController.captureFrame(now);
        }
    }
}
