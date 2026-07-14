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
import { AnalysisPanel } from "./ui/AnalysisPanel.js";
import { InteractionController } from "./components/InteractionController.js";
import { buildBodyMeta, resolveStateBodies, topoSortBodies } from "./utils/bodyTransforms.js";
import {
    decodeFloat32Blob,
    decodeStateField,
    decodeStatesChunk,
    STATE_FIELD_WIDTHS,
} from "./utils/blobCodec.js";
import { StateStore } from "./components/StateStore.js";
import { shouldFollowLive } from "./utils/liveFollow.js";

export class SimView {
    constructor() {
        this.scene = null;
        this.uiControls = null;
        this.bodyStateWindow = null;
        this.animationController = null;
        this.scalarPlotter = null;
        this.errorMetrics = null;
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
    }

    static run() {
        const simView = new SimView();
        simView.initAndAnimate();
    }

    // Fetch the model and states over HTTP (both served pre-gzipped by the server,
    // transparently decompressed by the browser) and build the scene from them.
    async loadData() {
        const splash = document.getElementById("loading-splash");
        try {
            if (splash) splash.innerHTML = "<h1>Loading Model (HTTP)...</h1>";
            console.time("fetch_model");
            const modelResponse = await fetch("/model");
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
            const statesResponse = await fetch("/states");
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

    // Walks any JSON-shaped object/array (the model, or the columnar states
    // payload) collecting every "/blob/..." reference, then fetches them all
    // in parallel and replaces each in place with its decoded Float32Array --
    // sequential awaits here would serialize what's otherwise an
    // embarrassingly parallel set of independent HTTP requests.
    async fetchBlobs(obj) {
        const refs = [];
        const collect = (node) => {
            if (!node || typeof node !== 'object') return;
            for (const key of Object.keys(node)) {
                const val = node[key];
                if (typeof val === 'string' && val.startsWith('/blob/')) {
                    refs.push({ container: node, key, url: val });
                } else if (typeof val === 'object') {
                    collect(val);
                }
            }
        };
        collect(obj);

        await Promise.all(
            refs.map(async ({ container, key, url }) => {
                const res = await fetch(url);
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
            const { states } = JSON.parse(event.data);
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
            if (this.scalarPlotter) {
                this.scalarPlotter.initFromStore(this.store);
            }
        }
        this.appendBodyHistories(0);
        if (this.errorMetrics) {
            this.errorMetrics.onHistoryReady();
        }
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

            this.batchManager = new BatchManager(this, model);
            this.bodies = new Map();

            // Auto-detect visualization mode based on first body: anything with a
            // real surface (box/sphere/cylinder/mesh) defaults to mesh; pointclouds
            // keep the default points mode.
            if (Array.isArray(model.bodies) && model.bodies.length > 0) {
                const firstShape = model.bodies[0].shape;
                if (firstShape && firstShape.type !== "pointcloud") {
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
            } else {
                throw new Error("Terrain data is missing in model");
            }
            const hasScalars = model.scalarNames && model.scalarNames.length > 0;
            const hasErrorMetrics = this.batchManager.simBatches >= 2;
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
