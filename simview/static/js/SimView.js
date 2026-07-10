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

export class SimView {
    constructor() {
        this.scene = null;
        this.socket = null;
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
        this.canReceiveStates = true; // Flag to control states reception
        this.animate = this.animate.bind(this);
    }

    static run() {
        const simView = new SimView();
        simView.initAndAnimate();
    }

    initializeSocket() {
        const socket = io();
        this.socket = socket;

        // Remove any existing listeners to prevent duplicates
        socket.off("connect");
        socket.off("disconnect");
        socket.off("error");
        socket.off("model");
        socket.off("states");

        socket.on("disconnect", () => console.log("Disconnected from server"));
        socket.on("error", (error) => {
            console.error("WebSocket Error:", error);
            const splash = document.getElementById("loading-splash");
            if (splash) {
                splash.innerHTML = `<h1 style="color: red;">WebSocket Error</h1><p>${error.message || "Unknown error"}</p>`;
            }
        });

        // Define the states handler
        const statesHandler = (statesData) => {
            if (this.canReceiveStates) {
                console.debug(`Received ${statesData.length} states`);
                this.canReceiveStates = false; // Block further states until new model
                this.processStates(statesData);
            } else {
                console.debug("States received but blocked until new model arrives");
            }
        };

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("Timeout waiting for model from server after 120s"));
            }, 120000);

            const doFetch = async () => {
                console.log("Connected to server, starting data fetch...");
                const splash = document.getElementById("loading-splash");
                
                try {
                    if (splash) splash.innerHTML = "<h1>Loading Model (HTTP)...</h1>";
                    console.time("fetch_model");
                    const modelResponse = await fetch("/model");
                    console.timeEnd("fetch_model");
                    
                    if (!modelResponse.ok) throw new Error(`Failed to fetch model: ${modelResponse.status} ${modelResponse.statusText}`);
                    
                    if (splash) splash.innerHTML = "<h1>Parsing Model JSON...</h1>";
                    console.time("parse_model");
                    const model = await modelResponse.json();
                    console.timeEnd("parse_model");

                    console.time("fetch_blobs");
                    await this.fetchModelBlobs(model);
                    console.timeEnd("fetch_blobs");

                    console.log("Model received, initializing components...");
                    this.initFromModel(model);
                    this.canReceiveStates = true;

                    // Request states via WebSocket chunking
                    socket.emit("request_states");

                    socket.off("states_chunk");
                    socket.on("states_chunk", (chunkBytes) => {
                        const jsonStr = new TextDecoder().decode(chunkBytes);
                        const chunk = JSON.parse(jsonStr);
                        if (this.canReceiveStates) {
                            console.debug(`Received chunk of ${chunk.length} states`);
                            const splash = document.getElementById("loading-splash");
                            if (splash) splash.remove();
                            this.processStatesChunk(chunk);
                        }
                    });

                    console.log("Initialization complete!");
                    clearTimeout(timeout);
                    resolve();
                } catch (error) {
                    console.error("Critical error during initial data fetch:", error);
                    if (splash) {
                        splash.innerHTML = `<h1 style="color: red;">Load Error</h1><p>${error.message}</p><p>Check browser console for details.</p>`;
                    }
                    reject(error);
                }
            };

            if (socket.connected) {
                doFetch();
            } else {
                socket.once("connect", doFetch);
            }
        });
    }

    async fetchModelBlobs(obj) {
        if (!obj || typeof obj !== 'object') return;
        for (const key of Object.keys(obj)) {
            const val = obj[key];
            if (typeof val === 'string' && val.startsWith('/blob/')) {
                const res = await fetch(val);
                const arrayBuffer = await res.arrayBuffer();
                const dataView = new DataView(arrayBuffer);
                const floatArray = new Float32Array(arrayBuffer.byteLength / 4);
                for (let i = 0; i < floatArray.length; i++) {
                    floatArray[i] = dataView.getFloat32(i * 4, true); // true = little-endian
                }
                obj[key] = floatArray;
            } else if (typeof val === 'object') {
                await this.fetchModelBlobs(val);
            }
        }
    }

    // Per-body state fields that add_trajectory(binary=True) packs as float32
    // `__b64__` blobs, with the trailing width used to reshape into per-batch rows.
    static STATE_FIELD_WIDTHS = {
        bodyTransform: 7,
        velocity: 3,
        angularVelocity: 3,
        force: 3,
        torque: 3,
    };

    // Decode a base64 float32 state field (little-endian, matching Python's "<f4")
    // into an array of per-batch rows, e.g. [[x,y,z,w,qx,qy,qz], ...].
    decodeStateField(str, width) {
        const bin = atob(str.slice(7)); // strip "__b64__"
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const floats = new Float32Array(bytes.buffer);
        const rows = new Array(floats.length / width);
        for (let r = 0; r < rows.length; r++) {
            const row = new Array(width);
            const base = r * width;
            for (let c = 0; c < width; c++) row[c] = floats[base + c];
            rows[r] = row;
        }
        return rows;
    }

    // Expand any binary-encoded per-body fields in a states chunk in place, so all
    // downstream consumers see the same nested-array shape as legacy JSON states.
    decodeStatesChunk(chunk) {
        const widths = SimView.STATE_FIELD_WIDTHS;
        for (const state of chunk) {
            if (!state.bodies) continue;
            for (const bodyState of state.bodies) {
                for (const field in widths) {
                    const v = bodyState[field];
                    if (typeof v === "string" && v.startsWith("__b64__")) {
                        bodyState[field] = this.decodeStateField(v, widths[field]);
                    }
                }
            }
        }
    }

    processStatesChunk(chunk) {
        this.decodeStatesChunk(chunk);
        if (!this.statesBuffer) {
            this.statesBuffer = [];
        }
        const startIndex = this.statesBuffer.length;
        this.statesBuffer.push(...chunk);

        if (this.animationController) {
            if (startIndex === 0) {
                this.animationController.loadAnimation(this.statesBuffer);
                if (this.scalarPlotter) {
                    this.scalarPlotter.initFromStates(this.statesBuffer);
                }
            } else {
                this.animationController.onStatesAppended();
                if (this.scalarPlotter) {
                    // scalarPlotter pulls from states array by reference usually
                }
            }
        }

        this.appendBodyHistories(chunk, startIndex);
        if (this.errorMetrics) {
            this.errorMetrics.onHistoryReady();
        }
    }

    appendBodyHistories(chunk, startIndex) {
        if (!this.bodies || this.bodies.size === 0) return;
        for (let i = 0; i < chunk.length; i++) {
            const s = startIndex + i;
            const bodyStates = chunk[i].bodies;
            if (!bodyStates) continue;
            for (const bodyState of bodyStates) {
                const body = this.bodies.get(bodyState.name);
                if (body) {
                    if (body.appendHistoryPointAt) {
                        body.appendHistoryPointAt(s, bodyState);
                    } else if (body.setHistoryPointAt) {
                        body.setHistoryPointAt(s, bodyState);
                    }
                }
            }
        }
        this.bodies.forEach((body) => {
            if (body.finalizeTrails) body.finalizeTrails();
        });
    }

    processStates(statesData) {
        this.processStatesChunk(statesData);
    }

    // Precomputes per-body, per-batch position/orientation history in a single
    // pass over all states. Powers trajectory trails and the error metrics panel.
    buildBodyHistories(states) {
        this.appendBodyHistories(states, 0);
    }

    initFromModel(model) {
        try {
            this.disposeOfAll();

            this.batchManager = new BatchManager(this, model);
            this.bodies = new Map();

            // Auto-detect visualization mode based on first body
            if (Array.isArray(model.bodies) && model.bodies.length > 0) {
                const firstShape = model.bodies[0].shape;
                // Check for numeric type 1 (Box) or string "box"/"mesh"/"sphere"/"cylinder"
                const isMeshType = (typeof firstShape.type === 'number' && firstShape.type !== 5) ||
                    (typeof firstShape.type === 'string' && firstShape.type !== 'pointcloud');

                if (isMeshType) {
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
            await this.initializeSocket();
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
