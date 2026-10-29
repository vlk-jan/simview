import * as THREE from "three";
import { Scene } from "./components/Scene.js";
import { UIControls } from "./ui/Controls.js";
import { BodyStateWindow } from "./ui/BodyStateWindow.js";
import { AnimationController } from "./components/AnimationController.js";
import { UI_DEFAULT_CONFIG } from "./config.js";
import { Body } from "./objects/Body.js";
import { Terrain } from "./objects/Terrain.js";
import { BatchManager, batchCountOf } from "./components/BatchManager.js";
import { ScalarPlotter } from "./ui/ScalarPlotter.js";
import { StaticObject } from "./objects/StaticObject.js";
import { Polyline } from "./objects/Polyline.js";
import { Legend } from "./ui/Legend.js";
import { BatchLegend } from "./ui/BatchLegend.js";
import { ErrorMetrics } from "./ui/ErrorMetrics.js";
import { TerrainProfile } from "./ui/TerrainProfile.js";
import { AnalysisPanel } from "./ui/AnalysisPanel.js";
import { InteractionController } from "./components/InteractionController.js";
import { buildBodyMeta, resolveStateBodies, topoSortBodies } from "./utils/bodyTransforms.js";
import { hasBodyTrajectory } from "./utils/terrainSample.js";
import { decodeStatesChunk, STATE_FIELD_WIDTHS } from "./utils/blobCodec.js";
import { ColumnarStateStore, LegacyStateStore } from "./components/StateStore.js";
import { WindowedField } from "./components/WindowedField.js";
import { escapeHtml } from "./utils/html.js";
import { bytesPerFrame, shouldWindowField } from "./utils/blobWindow.js";
import { shouldFollowLive } from "./utils/liveFollow.js";
import { shiftEpisodes } from "./utils/episodes.js";
import { parseViewState, parseStartupOptions, safeStaticBase, serializeViewState, toggleMapFromUiState } from "./utils/viewState.js";
import { mergeUiDefaults, applyViewerDomDefaults, panelHideCss } from "./utils/viewerDefaults.js";

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
        this.polylines = null;
        this.uiState = structuredClone(UI_DEFAULT_CONFIG);
        this.animate = this.animate.bind(this);
        // Live streaming mode (see startLiveStream): the open WebSocket (or
        // null once closed/if never opened) and its "LIVE" badge element.
        this.liveSocket = null;
        this.liveBadge = null;
        // Live mode: absolute frame index (on the producer's timeline) of this
        // viewer's frame 0 -- a late-joining tab only gets the catch-up window.
        // null until the first chunk arrives; see shiftEpisodes.
        this.liveFrameOffset = null;
        // Static demo mode: set from window.__simviewStaticBase (the GitHub
        // Pages demo index.html) or the `data=` startup hash key; all data
        // fetches then go to flat static files (model.json, states.json,
        // blob/N) instead of the Python backend API endpoints. null in
        // normal server mode.
        this.staticBase = null;
        // `play=1` startup hash key: start playback once the scene is loaded.
        this.autoplay = false;
        this._rafId = null;
        this._lastDispatchedFrame = -1;
        this._onHashChange = () => this.applyViewStateFromHash();
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
        // Startup hash keys (see parseStartupOptions): `data` wins over the global.
        // The `data` value is validated against this page's origin (see
        // safeStaticBase) -- the hash is attacker-controllable via a crafted
        // link. `hide = []`: a browser cache serving an older viewState.js
        // alongside this file must degrade to showing the panels, not a
        // broken viewer.
        const { data, ui, play, hide = [] } = parseStartupOptions(location.hash);
        if (data) simView.staticBase = safeStaticBase(data);
        if (!ui) document.body.classList.add("sv-embed");
        simView.autoplay = play;
        // `hide=recording,legend`: same stylesheet mechanism as
        // viewerDefaults.panels, injected up front since it's pure CSS.
        const hideCss = panelHideCss(Object.fromEntries(hide.map((name) => [name, false])));
        if (hideCss) {
            const style = document.createElement("style");
            style.textContent = hideCss;
            document.head.appendChild(style);
        }
        window.simview = simView;
        window.__debugSimView = simView; // alias kept for e2e tests / downstream consumers
        simView.initAndAnimate();
    }

    // Fetch the model and states over HTTP (both served pre-gzipped by the server,
    // transparently decompressed by the browser) and build the scene from them.
    // In static demo mode (this.staticBase non-null) the same paths are
    // redirected to pre-dumped flat files: model.json, states.json, blob/N.
    async loadData() {
        const splash = document.getElementById("loading-splash");
        const base = this.staticBase;
        // Requests the page started before the modules loaded (see
        // templates/index.html), each usable once. /states doesn't depend on
        // the model, so it's requested alongside it instead of after
        // initFromModel.
        const prefetched = base ? null : window.__simviewPrefetch;
        window.__simviewPrefetch = null;
        const statesFetch = prefetched?.states ?? fetch(base ? `${base}/states.json` : "/states");
        statesFetch.catch(() => {}); // surfaced where it's awaited below
        try {
            if (splash) splash.innerHTML = "<h1>Fetching model…</h1>";
            console.time("fetch_model");
            const modelResponse = await (prefetched?.model ?? fetch(base ? `${base}/model.json` : "/model"));
            console.timeEnd("fetch_model");
            if (!modelResponse.ok)
                throw new Error(`Failed to fetch model: ${modelResponse.status} ${modelResponse.statusText}`);

            if (splash) splash.innerHTML = "<h1>Parsing model…</h1>";
            console.time("parse_model");
            const model = await modelResponse.json();
            console.timeEnd("parse_model");

            // The states side needs only the batch count (not the built
            // scene), so its parse + blob downloads overlap the model's blobs
            // and initFromModel instead of queueing behind them.
            const batchCount = batchCountOf(model);
            const statesReady = this.fetchStatesPayload(statesFetch, batchCount);
            statesReady.catch(() => {}); // surfaced where it's awaited below

            console.time("fetch_blobs");
            this.deferTerrainPropertyBlobs(model);
            await this.fetchBlobs(model);
            console.timeEnd("fetch_blobs");

            console.log("Model received, initializing components...");
            this.initFromModel(model);

            if (splash) splash.innerHTML = "<h1>Fetching states…</h1>";
            const statesPayload = await statesReady;

            if (Array.isArray(statesPayload)) {
                // Legacy wire shape: a plain per-frame array, possibly with
                // inline __b64__ fields to expand.
                console.debug(`Received ${statesPayload.length} states (legacy)`);
                this.processStatesChunk(statesPayload);
            } else if (statesPayload && statesPayload.live === true) {
                // Live streaming mode (see simview.live.LiveViewer): no states
                // yet, they arrive incrementally over /ws/states instead.
                console.debug("Live mode: opening /ws/states");
                this.store = new LegacyStateStore([]);
                this.startLiveStream(splash);
            } else if (statesPayload && statesPayload.version === 4) {
                // Columnar wire shape (see columnar.py::columnarize_states):
                // a lightweight index plus /blob/... URLs for the actual
                // whole-trajectory float32 data, already fetched by
                // fetchStatesPayload.
                console.debug(`Received ${statesPayload.times.length} states (columnar)`);
                this.store = new ColumnarStateStore(statesPayload, this.batchManager.simBatches);
                this.onStoreReady();
            } else {
                throw new Error("Unrecognized /states payload shape");
            }

            // Live mode leaves the splash up until the first frame arrives
            // (startLiveStream's onmessage handler removes it).
            if (splash && !this.liveSocket) splash.remove();
            console.log("Initialization complete!");
        } catch (error) {
            console.error("Critical error during initial data fetch:", error);
            if (splash) {
                splash.innerHTML = `<h1 class="sv-splash-error">Couldn't load the simulation</h1><p>${escapeHtml(error.message)}</p><p>See the browser console for details.</p>`;
            }
            throw error;
        }
    }

    // Fetches and parses /states and, for the columnar shape, downloads its
    // blobs (long trajectories' biggest current-frame-only fields are swapped
    // for windowed readers first, so they are never materialized in full --
    // see utils/blobWindow.js). Resolves to the payload.
    async fetchStatesPayload(statesFetch, batchCount) {
        console.time("fetch_states");
        const statesResponse = await statesFetch;
        console.timeEnd("fetch_states");
        if (!statesResponse.ok)
            throw new Error(`Failed to fetch states: ${statesResponse.status} ${statesResponse.statusText}`);

        console.time("parse_states");
        const payload = await statesResponse.json();
        console.timeEnd("parse_states");

        if (payload && !Array.isArray(payload) && payload.version === 4) {
            this.windowLargeStateFields(payload, batchCount);
            console.time("fetch_state_blobs");
            await this.fetchBlobs(payload);
            console.timeEnd("fetch_state_blobs");
        }
        return payload;
    }

    // Replaces the blob URL of every large, current-frame-only per-body field
    // with a WindowedField, so fetchBlobs skips it and it's read in windows
    // around the playhead instead. Static demo mode is excluded: it serves
    // pre-dumped flat files with no Range support.
    //
    // bodyTransform, contacts and the scalars are deliberately untouched --
    // trails, error metrics, the terrain profile and the scalar plots all walk
    // the whole trajectory, so windowing those would just move the cost.
    windowLargeStateFields(statesPayload, batchCount) {
        if (this.staticBase) return;
        const totalFrames = statesPayload.times.length;
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
                    // A paused scrub into a non-resident window has nothing
                    // else to re-render the frame once it lands.
                    onLanded: () => this.animationController?.onWindowLanded(),
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
                    refs.push({ container: node, key, url: this.blobUrl(val) });
                } else if (typeof val === 'object') {
                    collect(val);
                }
            }
        };
        collect(obj);

        await Promise.all(
            refs.map(async ({ container, key, url }) => {
                container[key] = await this.fetchBlob(url);
            })
        );
    }

    // Static mode: /blob/{token}/{id} → {staticBase}/blob/{id}
    blobUrl(ref) {
        return this.staticBase ? `${this.staticBase}/blob/${ref.split("/").pop()}` : ref;
    }

    async fetchBlob(url) {
        const res = await fetch(url);
        // Without this check a 404/500 body (an error page) would be
        // silently reinterpreted as float32 data, corrupting whatever
        // geometry/trajectory referenced this blob.
        if (!res.ok) {
            throw new Error(`Failed to fetch blob ${url}: ${res.status} ${res.statusText}`);
        }
        // Little-endian float32 by contract (Python "<f4").
        return new Float32Array(await res.arrayBuffer());
    }

    // Swaps each terrain property layer's blob URL for a loader, so fetchBlobs
    // skips it (it only collects strings) and Terrain fetches the layer the
    // first time it's shown -- one color mode is visible at a time and most
    // sessions never leave "height". See Terrain.loadProperty.
    deferTerrainPropertyBlobs(model) {
        for (const prop of Object.values(model.terrain?.properties || {})) {
            if (typeof prop?.data !== "string" || !prop.data.startsWith("/blob/")) continue;
            const url = this.blobUrl(prop.data);
            prop.data = { load: () => this.fetchBlob(url) };
        }
    }

    // Opens the live-streaming WebSocket (see simview.live.LiveViewer): each
    // message is `{states: [<frame>, ...]}` -- one catch-up message with
    // every frame buffered so far, then one message per subsequently pushed
    // frame -- and is run through the same processStatesChunk path the
    // static per-frame legacy wire shape uses. `splash` (the loading-splash
    // element, still showing its last loading message) is removed once the
    // first frame arrives.
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
            const { states, frameOffset } = message;
            if (!states || states.length === 0) return;
            if (this.liveFrameOffset === null) {
                // Absent on an older server: assume the stream starts at 0.
                this.liveFrameOffset = Number.isInteger(frameOffset) ? frameOffset : 0;
            }
            this.processStatesChunk(states);
            if (splash) splash.remove();
        };
        socket.onclose = () => {
            console.log("Live stream closed (simulation finished serving).");
            this.liveSocket = null;
            this.hideLiveBadge();
            // The splash is only removed once a frame arrives (above), so it
            // still being attached means the connection died before the run
            // started -- e.g. refused by the server's origin check (a viewer
            // opened by hostname; see /ws/states). Show why instead of leaving
            // "Fetching states…" up forever.
            if (splash && splash.isConnected) {
                splash.innerHTML =
                    `<h1 class="sv-splash-error">Couldn't start the live stream</h1>` +
                    `<p>${escapeHtml(
                        "The server refused the connection. If the viewer was opened by hostname, " +
                        "open it by its address instead (e.g. http://10.0.0.5:5420). " +
                        "See the browser console and the server log for details.",
                    )}</p>`;
            }
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
        // Live: startIndex is absolute on the producer's timeline, our frame 0
        // is the catch-up window's first frame.
        const local = shiftEpisodes(this.episodes, this.liveFrameOffset ?? 0);
        const controls = this.animationController?.playbackControls;
        if (controls) controls.setEpisodes(local);
        if (this.scalarPlotter) this.scalarPlotter.setEpisodes(local);
    }

    showLiveBadge() {
        if (this.liveBadge) return;
        const badge = document.createElement("div");
        badge.className = "sv-live-badge";
        badge.textContent = "LIVE";
        document.body.appendChild(badge);
        this.liveBadge = badge;
    }

    hideLiveBadge() {
        if (this.liveBadge) {
            this.liveBadge.remove();
            this.liveBadge = null;
        }
    }

    // Legacy wire shape entry point (also every live chunk): decodes inline
    // __b64__ fields and adds the frames to a LegacyStateStore. Branches on
    // whether the animation is loaded yet rather than on `this.store`,
    // because live mode creates an empty store up front and its first chunk
    // must still take the first-load path (onStoreReady).
    processStatesChunk(chunk) {
        decodeStatesChunk(chunk);
        const firstLoad = !this.animationController || !this.animationController.store;
        if (!this.store) {
            this.store = new LegacyStateStore(chunk);
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
            if (this.scalarPlotter) {
                this.scalarPlotter.onStatesAppended();
            }
            if (this.terrainProfile) {
                this.terrainProfile.onStatesAppended();
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
    // consumers.
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
        if (this.uiControls) this.uiControls.updateTrackBodyOptions();
        this.maybeAttachTrajectoryPanels();
    }

    // The Error Metrics and Terrain tabs need a body with an actual trajectory to sample
    // terrain along (a static point cloud with no states doesn't count),
    // which is only known once appendBodyHistories() has filled each body's
    // validStates. Error Metrics compares batches over time, so it needs the
    // same plus at least two batches; a static scene gets neither tab.
    maybeAttachTrajectoryPanels() {
        if (!hasBodyTrajectory(this.bodies)) return;
        this.analysisPanel ??= new AnalysisPanel(this);
        if (this.batchManager.simBatches >= 2 && !this.errorMetrics) {
            this.errorMetrics = new ErrorMetrics(this);
            this.errorMetrics.onHistoryReady();
            this.analysisPanel.attach("errorMetrics", this.errorMetrics, this.errorMetrics.content);
        }
        if (this.terrain && !this.terrainProfile) {
            this.terrainProfile = new TerrainProfile(this);
            this.analysisPanel.attach("terrain", this.terrainProfile, this.terrainProfile.content);
        }
    }

    // Resolves and records position/orientation (and contacts, vectors, ...)
    // history for every frame from `startIndex` to the end of the store, for
    // trails and the error metrics panel. Each frame is materialized
    // transiently via store.getTransformFrame(i) (not retained) so this works
    // identically whether the store is legacy or columnar.
    appendBodyHistories(startIndex) {
        if (!this.bodies || this.bodies.size === 0) return;
        for (let s = startIndex; s < this.store.length; s++) {
            const bodyStates = this.store.getTransformFrame(s).bodies;
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
                this.bodies.get(name)?.appendHistoryPointAt(s, resolvedBodyState);
            });
        }
        this.bodies.forEach((body) => body.finalizeTrails());
    }

    // Builds the scene and every panel from the fetched model: batches,
    // bodies, static objects, polylines, terrain and UI. States arrive
    // afterwards (see loadData) and are wired in by onStoreReady.
    initFromModel(model) {
        try {
            this.disposeOfAll();
            this.model = model;

            // Free-form run provenance carried through from the Python side
            // (see SimViewModel.metadata) -- no meaning to the viewer itself,
            // just displayed read-only in the "Scene Info" GUI folder.
            this.metadata = model.metadata ?? null;

            // Episode boundaries for an episodic (RL) recording, applied to
            // the playback bar once the store exists (see onStoreReady).
            // Absent for an ordinary single-timeline scene.
            this.episodes = Array.isArray(model.episodes) ? model.episodes : [];

            // Before anything reads model.terrain (BatchManager does), so the
            // splash shows this rather than a TypeError.
            if (!model.terrain) {
                throw new Error("Terrain data is missing in model");
            }

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

            // Authoring-time UI defaults (see utils/viewerDefaults.js). After the
            // auto-detect above so they win, and before any Body/Terrain/Controls
            // read uiState.
            this.uiState = mergeUiDefaults(this.uiState, model.viewerDefaults?.ui);

            if (Array.isArray(model.bodies)) {
                model.bodies.forEach((bodyData) => {
                    const body = new Body(bodyData, this);
                    this.bodies.set(bodyData.name, body);
                    this.scene.addObject3D(body.getObject3D());
                });
            }
            // Parent-relative transforms (rigid/articulated attachments, see
            // docs/dev/json-format.md): resolved once here so per-frame/per-state consumers
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
            this.polylines = (model.polylines || []).map((data) => {
                const polyline = new Polyline(data, this);
                this.scene.addObject3D(polyline.getObject3D());
                return polyline;
            });
            this.terrain = new Terrain(model.terrain, this);
            this.scene.addObject3D(this.terrain.getObject3D());
            // Terrain extent is what tells us how far this scene reaches,
            // so the camera's clipping/orbit range can stop being a guess.
            this.scene.applySceneExtent(this.terrain.bounds);
            const hasScalars = model.scalarNames && model.scalarNames.length > 0;
            // The Error Metrics and Terrain tabs are attached later, from
            // onStoreReady (see maybeAttachTrajectoryPanels).
            if (hasScalars) {
                this.analysisPanel = new AnalysisPanel(this);
                console.debug(
                    "Initializing scalar plotter for scalars",
                    model.scalarNames
                );
                this.scalarPlotter = new ScalarPlotter(this, model.scalarNames);
                const { tabBar, plotArea } = this.scalarPlotter;
                this.analysisPanel.attach("scalars", this.scalarPlotter, tabBar, plotArea);
            }
            this.interactionController = new InteractionController(this);
            this.uiControls = new UIControls(this);
            this.bodyStateWindow = new BodyStateWindow(this);
            this.legend = new Legend(this);
            if (this.batchManager.simBatches >= 2) {
                this.batchLegend = new BatchLegend(this);
            }
            this.animationController = new AnimationController(this, model.dt);
            applyViewerDomDefaults(this, model.viewerDefaults);
        } catch (error) {
            console.error("Error during initFromModel:", error);
            const splash = document.getElementById("loading-splash");
            if (splash) {
                splash.innerHTML = `<h1 class="sv-splash-error">Error during initialization</h1><p>${escapeHtml(error.message)}</p>`;
            }
            throw error;
        }
    }

    async initAndAnimate() {
        try {
            this.scene = new Scene(this);
            await this.loadData();
            this.applyViewStateFromHash();
            // After the view state, so `#v=1&t=30&play=1` seeks to 30 and then
            // plays (`t` pauses). Live mode has no timeline yet: nothing to play.
            if (this.autoplay && this.animationController?.store) this.animationController.play();
            window.addEventListener("hashchange", this._onHashChange);
            this.animate();
            // Live mode leaves the splash up until the first frame arrives
            // (see startLiveStream).
            const splash = document.getElementById("loading-splash");
            if (splash && !this.liveSocket) splash.remove();
            window.dispatchEvent(new CustomEvent("simview:ready", { detail: { simview: this } }));
        } catch (error) {
            console.error("Initialization failed:", error);
            const splash = document.getElementById("loading-splash");
            if (splash) {
                splash.innerHTML = `<h1 class="sv-splash-error">Failed to connect or initialize</h1><p>${escapeHtml(error.message)}</p>`;
            }
        }
    }

    // Applies the shareable view link in location.hash (see
    // utils/viewState.js). Runs once after loadData() and on every hashchange.
    applyViewStateFromHash() {
        const state = parseViewState(location.hash);
        if (state) this.setViewState(state);
    }

    // Applies a parsed view-state object (see utils/viewState.js): batch, pause +
    // seek when `time` is present, camera, and UI toggles. Never touches
    // location.hash, and a bad partial state is logged rather than thrown.
    setViewState(state) {
        if (!state) return;

        try {
            if (this.batchManager && Number.isInteger(state.batchIndex)) {
                this.batchManager.setActiveBatch(state.batchIndex);
            }

            // Only `t` pauses (and seeks); a hash that changes e.g. the colour
            // map leaves playback running, as the embedding docs promise.
            if (this.animationController && this.animationController.store && Number.isFinite(state.time)) {
                this.animationController.pause();
                this.animationController.goToTime(state.time);
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
                if (this.animationController && state.playbackSpeed !== undefined) {
                    this.animationController.setSpeed(state.playbackSpeed); // rejects <= 0 / non-finite
                }
                this.uiControls.applyViewState(state);
            }
        } catch (e) {
            console.warn("Failed to apply view state from URL hash:", e);
        }
    }

    // Returns the current view state: the object "Copy view link" serialises.
    getViewState() {
        const { camera, controls } = this.scene;
        return {
            time: this.animationController ? this.animationController.currentTime : undefined,
            camera: {
                position: camera.position.clone(),
                target: controls.target.clone(),
                fov: camera.fov,
            },
            batchIndex: this.batchManager ? this.batchManager.currentlyActiveBatch : undefined,
            bodyVisualizationMode: this.uiState.bodyVisualizationMode,
            terrainColorMode: this.uiState.terrainColorMode,
            toggles: toggleMapFromUiState(this.uiState),
            pointCloudsVisible: this.uiState.pointCloudsVisible,
            trackBody: this.uiState.trackBody,
            terrainColorMap: this.uiState.terrainColorMap,
            playbackSpeed: this.animationController ? this.animationController.playbackSpeed : undefined,
        };
    }

    // Moves the camera and orbit target together so the target lands on the body's
    // current world position. Returns false if the body/position isn't available yet.
    focusBody(name, batchIndex = this.batchManager.currentlyActiveBatch) {
        const pos = this.bodies && this.bodies.get(name) && this.bodies.get(name).positions[batchIndex];
        if (!pos) return false;
        const offset = this.batchManager.getBatchOffset(batchIndex);
        const target = new THREE.Vector3(pos.x + offset.x, pos.y + offset.y, pos.z + offset.z);
        const { camera, controls } = this.scene;
        camera.position.add(target.clone().sub(controls.target));
        controls.target.copy(target);
        controls.update();
        return true;
    }

    // Stops the render loop, closes the live socket, and releases the scene, UI and renderer.
    destroy() {
        cancelAnimationFrame(this._rafId);
        if (this.liveSocket) this.liveSocket.close();
        window.removeEventListener("hashchange", this._onHashChange);
        this.disposeOfAll();
        if (this.scene) this.scene.dispose();
        if (window.simview === this) window.simview = null;
        if (window.__debugSimView === this) window.__debugSimView = null;
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
        if (this.polylines) {
            for (const polyline of this.polylines) {
                polyline.dispose();
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
        this._rafId = requestAnimationFrame(this.animate);
        const now = performance.now();

        // 1. Update states and time
        if (this.animationController) {
            this.animationController.animate(now);
            const index = this.animationController.currentStateIndex;
            if (index !== this._lastDispatchedFrame && this.animationController.store) {
                this._lastDispatchedFrame = index;
                window.dispatchEvent(
                    new CustomEvent("simview:frame", { detail: { index, time: this.animationController.currentTime } })
                );
            }
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
                            if (
                                this._lastTrackedBody !== this.uiState.trackBody ||
                                this._lastTrackedBatch !== activeBatch
                            ) {
                                // On first tracking or a body/batch switch, center the target on the body, preserving the viewing angle
                                const delta = currentBodyPos.clone().sub(this.scene.controls.target);
                                this.scene.camera.position.add(delta);
                                this.scene.controls.target.copy(currentBodyPos);
                                this.scene.controls.update();
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
                        this._lastTrackedBatch = activeBatch;
                        this._lastTrackedPosition = currentBodyPos.clone();
                    }
                }
            } else {
                this._lastTrackedBody = null;
                this._lastTrackedBatch = null;
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
