import { GUI } from "three/addons/libs/lil-gui.module.min.js";
import { SELECTION_CONFIG } from "../config.js";
import { colorMapOptions } from "../../lib/js-colormaps.js";

export class UIControls {
    constructor(app) {
        this.app = app;
        this.attributeAvailability = this.determineAttributeAvailability();
        this.visualizationModes = this.determineAvailableVisualizationModes();
        this.gui = this.createDatGUI();
        this.keyboardControlsListener = null;
        this.setupKeyboardControls(app);
    }

    // Determine which attributes are available across all bodies
    determineAttributeAvailability() {
        const attributeTypes = [
            "contacts",
            "velocity",
            "angularVelocity",
            "force",
            "torque",
        ];
        const availability = {};

        // Initialize all attributes as unavailable
        attributeTypes.forEach((type) => {
            availability[type] = false;
        });

        // Check each body for available attributes
        this.app.bodies.forEach((body) => {
            const availableAttributes = body.getAvailableAttributes();
            attributeTypes.forEach((type) => {
                if (availableAttributes.has(type)) {
                    availability[type] = true;
                }
            });
        });

        return availability;
    }

    // Union of visualization modes actually available across all bodies, plus a
    // "none" option to hide bodies entirely (e.g. for terrain-only viewing).
    determineAvailableVisualizationModes() {
        const modes = new Set();
        this.app.bodies.forEach((body) => {
            body.getAvailableVisualizationModes().forEach((m) => modes.add(m));
        });
        modes.add("none");
        return [...modes];
    }

    changeTargetBatch(key) {
        const { scene, batchManager } = this.app;
        const currentBatchTarget = batchManager.currentlyActiveBatch;
        const { row, col } =
            batchManager.getRowColFromBatchIndex(currentBatchTarget);
        const azimuth = scene.controls.getAzimuthalAngle();
        const cosAz = Math.cos(azimuth);
        const sinAz = Math.sin(azimuth);
        let dx, dy;
        if (Math.abs(cosAz) > Math.abs(sinAz)) {
            dx = cosAz > 0 ? 1 : -1;
            dy = 0;
        } else {
            dx = 0;
            dy = sinAz > 0 ? 1 : -1;
        }
        let newRow = row;
        let newCol = col;
        switch (key) {
            case "arrowright":
                newRow += dy;
                newCol += dx;
                break;
            case "arrowleft":
                newRow -= dy;
                newCol -= dx;
                break;
            case "arrowdown":
                newRow -= dx;
                newCol += dy;
                break;
            case "arrowup":
                newRow += dx;
                newCol -= dy;
                break;
        }
        batchManager.setActiveBatchByRowCol(newRow, newCol);
    }

    createDatGUI() {
        this.gui = new GUI();

        // Only show body-related controls when there's actually a body to control
        if (this.app.bodies && this.app.bodies.size > 0) {
            let defaultVisualizationMode = this.app.uiState.bodyVisualizationMode;
            if (!this.visualizationModes.includes(defaultVisualizationMode)) {
                defaultVisualizationMode =
                    this.visualizationModes.find((m) => m !== "none") || "none";
                this.app.uiState.bodyVisualizationMode = defaultVisualizationMode;
            }

            const controls = {
                bodyVisualizationMode: defaultVisualizationMode,
                showAxes: this.app.uiState.axesVisible,
                showTrails: this.app.uiState.trailsVisible,
                showContacts: this.app.uiState.attributeVisible.contacts,
                showVelocity: this.app.uiState.attributeVisible.velocity,
                showAngularVelocity: this.app.uiState.attributeVisible.angularVelocity,
                showForce: this.app.uiState.attributeVisible.force,
                showTorque: this.app.uiState.attributeVisible.torque,
            };

            this.bodyFolder = this.gui.addFolder("Body Options");

            this.bodyFolder
                .add(controls, "bodyVisualizationMode", this.visualizationModes)
                .name("Body Visualization Mode (B)")
                .onChange((value) => {
                    this.updateVisualizationMode(value);
                });

            this.bodyFolder
                .add(controls, "showAxes")
                .name("Show Axes (A)")
                .onChange((value) => {
                    this.updateAxesVisibility(value);
                });

            this.bodyFolder
                .add(controls, "showTrails")
                .name("Show Trails (G)")
                .onChange((value) => {
                    this.updateTrailsVisibility(value);
                });

            // Only create toggles for attributes actually present in the loaded data
            const attributeControls = [
                { property: "showContacts", name: "Show Contacts (C)", type: "contacts" },
                {
                    property: "showVelocity",
                    name: "Show Linear Velocity (V)",
                    type: "velocity",
                },
                {
                    property: "showAngularVelocity",
                    name: "Show Angular Velocity (W)",
                    type: "angularVelocity",
                },
                {
                    property: "showForce",
                    name: "Show Linear Force (F)",
                    type: "force",
                },
                { property: "showTorque", name: "Show Torque (T)", type: "torque" },
            ];

            attributeControls
                .filter((control) => this.attributeAvailability[control.type])
                .forEach((control) => {
                    this.bodyFolder
                        .add(controls, control.property)
                        .name(control.name)
                        .onChange((value) => {
                            this.updateAttributeVisibility(control.type, value);
                        });
                });

            this.bodyFolder.open();
        }

        // Terrain controls (unchanged)
        this.terrainFolder = this.gui.addFolder("Terrain Options");

        const availableColorModes = this.app.terrain
            ? this.app.terrain.getAvailableColorModes()
            : ["height"];

        let currentColorMode = this.app.uiState?.terrainColorMode || "height";
        if (!availableColorModes.includes(currentColorMode)) {
            currentColorMode = availableColorModes[0] || "height";
            this.app.uiState.terrainColorMode = currentColorMode;
        }

        const terrainControls = {
            showSurface: this.app.uiState.terrainVisualizationModes?.surface ?? true,
            showWireframe:
                this.app.uiState.terrainVisualizationModes?.wireframe ?? false,
            showNormals: this.app.uiState.terrainVisualizationModes?.normals ?? false,
            colorMap: this.app.uiState?.terrainColorMap || "viridis",
            colorMode: currentColorMode,
            terrainProbe: this.app.uiState?.terrainProbe ?? false,
        };

        this.terrainFolder
            .add(terrainControls, "showSurface")
            .name("Show Surface")
            .onChange((value) => {
                this.updateTerrainVisualization("surface", value);
            });

        this.terrainFolder
            .add(terrainControls, "showWireframe")
            .name("Show Wireframe")
            .onChange((value) => {
                this.updateTerrainVisualization("wireframe", value);
            });

        this.terrainFolder
            .add(terrainControls, "showNormals")
            .name("Show Normals")
            .onChange((value) => {
                this.updateTerrainVisualization("normals", value);
            });

        this.terrainFolder
            .add(terrainControls, "colorMap", colorMapOptions)
            .name("Color Map")
            .onChange((value) => {
                this.updateTerrainColorMap(value);
            });

        this.terrainFolder
            .add(terrainControls, "colorMode", availableColorModes)
            .name("Color Mode")
            .onChange((value) => {
                this.updateTerrainColorMode(value);
            });

        const terrainProbeCtrl = this.terrainFolder
            .add(terrainControls, "terrainProbe")
            .name("Data Probe (P)")
            .onChange((value) => {
                this.app.uiState.terrainProbe = value;
                if (!value && this.app.interactionController) {
                    this.app.interactionController.hideTerrainTooltip();
                }
            });

        this.handleKeydown = (e) => {
            if (e.key.toLowerCase() === "p" && 
                !e.ctrlKey && !e.metaKey && !e.altKey && 
                document.activeElement.tagName !== "INPUT") {
                terrainProbeCtrl.setValue(!terrainProbeCtrl.getValue());
            }
        };
        window.addEventListener("keydown", this.handleKeydown);

        this.terrainFolder.open();

        const cameraFolder = this.gui.addFolder("Camera Options");
        const cameraControls = {
            fov: this.app.scene.camera.fov,
            trackBody: "None",
            splitScreen: false,
            splitBatchA: 0,
            splitBatchB: 1
        };
        cameraFolder
            .add(cameraControls, "fov", 20, 120)
            .name("Field of View")
            .onChange((value) => {
                this.app.scene.camera.fov = value;
                this.app.scene.camera.updateProjectionMatrix();
            });
        if (this.app.bodies && this.app.bodies.size > 0) {
            const bodyNames = ["None", ...Array.from(this.app.bodies.keys())];
            cameraFolder
                .add(cameraControls, "trackBody", bodyNames)
                .name("Track Body")
                .onChange((value) => {
                    this.app.uiState.trackBody = value;
                });
        }
            
        if (this.app.batchManager && this.app.batchManager.simBatches >= 2) {
            const batches = Array.from({length: this.app.batchManager.simBatches}, (_, i) => i);
            const splitScreenCtrl = cameraFolder.add(cameraControls, "splitScreen").name("Split Screen");
            const splitBatchACtrl = cameraFolder.add(cameraControls, "splitBatchA", batches).name("Split Batch A").onChange(v => this.app.uiState.splitBatchA = parseInt(v));
            const splitBatchBCtrl = cameraFolder.add(cameraControls, "splitBatchB", batches).name("Split Batch B").onChange(v => this.app.uiState.splitBatchB = parseInt(v));
            
            // Hide the batch selectors initially if splitScreen is off
            splitBatchACtrl.hide();
            splitBatchBCtrl.hide();
            
            splitScreenCtrl.onChange(v => {
                this.app.uiState.splitScreen = v;
                if (v) {
                    splitBatchACtrl.show();
                    splitBatchBCtrl.show();
                } else {
                    splitBatchACtrl.hide();
                    splitBatchBCtrl.hide();
                }
            });

            this.app.uiState.splitScreen = cameraControls.splitScreen;
            this.app.uiState.splitBatchA = cameraControls.splitBatchA;
            this.app.uiState.splitBatchB = cameraControls.splitBatchB;
        }
        
        this.cameraControls = cameraControls;

        return this.gui;
    }

    setupKeyboardControls(app) {
        this.keyboardControlsListener = window.addEventListener(
            "keydown",
            (event) => {
                switch (event.key.toLowerCase()) {
                    case "b":
                        const modes = this.visualizationModes;
                        const currentIndex = modes.indexOf(
                            this.app.uiState.bodyVisualizationMode
                        );
                        const nextIndex = (currentIndex + 1) % modes.length;
                        this.updateVisualizationMode(modes[nextIndex]);
                        const controller = this.findController("bodyVisualizationMode");
                        if (controller) controller.setValue(modes[nextIndex]);
                        break;
                    case "a":
                        this.toggleControl("showAxes");
                        break;
                    case "g":
                        this.toggleControl("showTrails");
                        break;
                    case "c":
                        if (this.attributeAvailability.contacts)
                            this.toggleControl("showContacts");
                        break;
                    case "v":
                        if (this.attributeAvailability.velocity)
                            this.toggleControl("showVelocity");
                        break;
                    case "w":
                        if (this.attributeAvailability.angularVelocity)
                            this.toggleControl("showAngularVelocity");
                        break;
                    case "f":
                        if (this.attributeAvailability.force)
                            this.toggleControl("showForce");
                        break;
                    case "t":
                        if (this.attributeAvailability.torque)
                            this.toggleControl("showTorque");
                        break;
                    case "arrowup":
                    case "arrowdown":
                    case "arrowleft":
                    case "arrowright":
                        if (event[SELECTION_CONFIG.BATCH.key]) {
                            this.changeTargetBatch(event.key.toLowerCase());
                            event.stopPropagation();
                        }
                        break;
                }
            }
        );
    }

    findController(property) {
        if (!this.bodyFolder) return null;
        for (const controller of this.bodyFolder.controllers) {
            if (controller.property === property) {
                return controller;
            }
        }
        return null;
    }

    toggleControl(property) {
        const controller = this.findController(property);
        if (controller) {
            controller.setValue(!controller.getValue());
        }
    }

    updateVisualizationMode(mode) {
        this.app.bodies.forEach((body) => {
            body.updateVisualizationMode(mode);
        });
        this.app.uiState.bodyVisualizationMode = mode;
    }

    updateAxesVisibility(show) {
        this.app.bodies.forEach((body) => {
            body.toggleAxes(show);
        });
        this.app.uiState.axesVisible = show;
    }

    updateTrailsVisibility(show) {
        this.app.bodies.forEach((body) => {
            body.toggleTrails(show);
        });
        this.app.uiState.trailsVisible = show;
    }

    updateAttributeVisibility(attrType, show) {
        this.app.bodies.forEach((body) => {
            if (attrType === "contacts") {
                body.toggleContactPoints(show);
            } else {
                body.toggleBodyVector(attrType, show);
            }
        });
        this.app.uiState.attributeVisible[attrType] = show;
    }

    updateTerrainVisualization(type, visible) {
        if (this.app.terrain) {
            this.app.terrain.toggleVisualization(type, visible);
            if (!this.app.uiState.terrainVisualizationModes) {
                this.app.uiState.terrainVisualizationModes = {};
            }
            this.app.uiState.terrainVisualizationModes[type] = visible;
        }
    }

    updateTerrainColorMap(colorMap) {
        if (this.app.terrain) {
            this.app.uiState.terrainColorMap = colorMap;
            this.app.terrain.setColorMap(colorMap);
            if (this.app.legend) this.app.legend.update();
        }
    }

    updateTerrainColorMode(mode) {
        if (this.app.terrain) {
            this.app.uiState.terrainColorMode = mode;
            this.app.terrain.setColorMode(mode);
            if (this.app.legend) this.app.legend.update();
        }
    }

    dispose() {
        if (this.handleKeydown) {
            window.removeEventListener("keydown", this.handleKeydown);
        }
        this.gui.destroy();
        this.gui = null;
        if (this.keyboardControlsListener) {
            window.removeEventListener("keydown", this.keyboardControlsListener);
            this.keyboardControlsListener = null;
        }
    }
}
