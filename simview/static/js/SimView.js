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

export class SimView {
    constructor() {
        this.scene = null;
        this.socket = null;
        this.uiControls = null;
        this.bodyStateWindow = null;
        this.animationController = null;
        this.scalarPlotter = null;
        this.legend = null;
        this.batchManager = null;
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

                    console.log("Model received, initializing components...");
                    this.initFromModel(model);
                    this.canReceiveStates = true;

                    if (splash) splash.innerHTML = "<h1>Loading States (HTTP)...</h1>";
                    console.time("fetch_states");
                    const statesResponse = await fetch("/states");
                    console.timeEnd("fetch_states");
                    
                    if (!statesResponse.ok) throw new Error(`Failed to fetch states: ${statesResponse.status} ${statesResponse.statusText}`);
                    
                    if (splash) splash.innerHTML = "<h1>Parsing States JSON...</h1>";
                    console.time("parse_states");
                    const statesData = await statesResponse.json();
                    console.timeEnd("parse_states");

                    console.log(`Received ${statesData.length} states, processing...`);
                    this.processStates(statesData);

                    socket.off("states");
                    socket.on("states", statesHandler);

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

    processStates(statesData) {
        if (this.animationController) {
            this.animationController.loadAnimation(statesData);
        }
        if (this.scalarPlotter) {
            this.scalarPlotter.initFromStates(statesData);
        }
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
            if (model.scalarNames && model.scalarNames.length > 0) {
                console.debug(
                    "Initializing scalar plotter for scalars",
                    model.scalarNames
                );
                this.scalarPlotter = new ScalarPlotter(this, model.scalarNames);
            }
            this.uiControls = new UIControls(this);
            this.bodyStateWindow = new BodyStateWindow(this);
            this.legend = new Legend(this);
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
        }
        if (this.bodyStateWindow) {
            this.bodyStateWindow.dispose();
        }
        if (this.legend) {
            this.legend.dispose();
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
        
        // 3. Render the scene
        if (this.scene) {
            this.scene.animate(now);
        }
        
        // 4. Capture the frame if recording
        if (this.animationController && this.animationController.isRecording) {
            this.animationController.captureFrame(now);
        }
    }
}
