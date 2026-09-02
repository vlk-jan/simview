import { GUI } from "three/addons/libs/lil-gui.module.min.js";
import { colorMapOptions } from "../../lib/js-colormaps.js";
import { RENDER_ALL, RENDER_FOCUSED } from "../utils/batchVisibility.js";
import { serializeViewState, toggleMapFromUiState } from "../utils/viewState.js";

export class UIControls {
    constructor(app) {
        this.app = app;
        this.attributeAvailability = this.determineAttributeAvailability();
        this.visualizationModes = this.determineAvailableVisualizationModes();
        this.hasPointClouds = this.determineHasPointClouds();
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
    // Point-cloud bodies contribute nothing and are unaffected by the mode --
    // they have their own toggle -- so a scene of nothing but point clouds
    // gets no mode control at all rather than a dropdown that only hides things.
    determineAvailableVisualizationModes() {
        const modes = new Set();
        this.app.bodies.forEach((body) => {
            body.getAvailableVisualizationModes().forEach((m) => modes.add(m));
        });
        if (modes.size === 0) return [];
        modes.add("none");
        return [...modes];
    }

    determineHasPointClouds() {
        let found = false;
        this.app.bodies.forEach((body) => {
            if (body.isPointCloud) found = true;
        });
        return found;
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
            if (
                this.visualizationModes.length > 0 &&
                !this.visualizationModes.includes(defaultVisualizationMode)
            ) {
                defaultVisualizationMode =
                    this.visualizationModes.find((m) => m !== "none") || "none";
                this.app.uiState.bodyVisualizationMode = defaultVisualizationMode;
            }

            const controls = {
                bodyVisualizationMode: defaultVisualizationMode,
                showPointClouds: this.app.uiState.pointCloudsVisible !== false,
                showAxes: this.app.uiState.axesVisible,
                showTrails: this.app.uiState.trailsVisible,
                smoothInterpolation: this.app.uiState.smoothInterpolation,
                showContacts: this.app.uiState.attributeVisible.contacts,
                showVelocity: this.app.uiState.attributeVisible.velocity,
                showAngularVelocity: this.app.uiState.attributeVisible.angularVelocity,
                showForce: this.app.uiState.attributeVisible.force,
                showTorque: this.app.uiState.attributeVisible.torque,
            };

            this.bodyFolder = this.gui.addFolder("Body Options");

            // Nothing to switch between when every body is a point cloud.
            if (this.visualizationModes.length > 0) {
                this.bodyFolder
                    .add(controls, "bodyVisualizationMode", this.visualizationModes)
                    .name("Body Visualization Mode (B)")
                    .onChange((value) => {
                        this.updateVisualizationMode(value);
                    });
            }

            if (this.hasPointClouds) {
                this.bodyFolder
                    .add(controls, "showPointClouds")
                    .name("Show Point Clouds")
                    .onChange((value) => {
                        this.updatePointCloudsVisibility(value);
                    });
            }

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

            this.bodyFolder
                .add(controls, "smoothInterpolation")
                .name("Smooth Interpolation (I)")
                .onChange((value) => {
                    this.updateSmoothInterpolation(value);
                });

            // Only worth offering with enough batches for it to matter; with a
            // handful, everything is drawn and the toggle is just noise.
            if (this.app.batchManager.simBatches > 1) {
                const renderControls = {
                    renderAllBatches:
                        this.app.batchManager.renderMode === RENDER_ALL,
                };
                this.bodyFolder
                    .add(renderControls, "renderAllBatches")
                    .name("Render All Batches")
                    .onChange((value) => {
                        this.app.batchManager.setRenderMode(
                            value ? RENDER_ALL : RENDER_FOCUSED
                        );
                    });
            }

            // Only shown when at least one body ships a per-point similarity
            // embedding (see Body.js's pointEmbedding / recolorBySimilarity).
            // Clicking a point already switches into "similarity" coloring
            // implicitly (InteractionController's #handlePointClick); this
            // dropdown's main job is letting you switch back to the static
            // PCA-RGB view without another click.
            const bodiesWithEmbedding = [...this.app.bodies.values()].filter(
                (body) => body.pointEmbedding
            );
            if (bodiesWithEmbedding.length > 0) {
                const pointColorControls = {
                    pointColorMode: this.app.uiState.pointColorMode || "pca",
                };
                this.bodyFolder
                    .add(pointColorControls, "pointColorMode", ["pca", "similarity"])
                    .name("Point Color Mode")
                    .onChange((value) => {
                        this.app.uiState.pointColorMode = value;
                        if (value === "pca") {
                            bodiesWithEmbedding.forEach((body) => body.resetPointColors());
                        }
                    });
            }

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
                this.updateDiffControlsVisibility(value);
            });

        // "diff" mode's own layer/batch-pair pickers -- only meaningful (and
        // only shown) when Color Mode is "diff". Mirrors the Camera Options
        // folder's splitBatchA/B show/hide-on-toggle pattern above.
        let diffLayerCtrl = null;
        let diffBatchACtrl = null;
        let diffBatchBCtrl = null;
        if (
            this.app.terrain &&
            this.app.batchManager &&
            this.app.batchManager.simBatches >= 2
        ) {
            const diffLayers = this.app.terrain.getAvailableDiffLayers();
            const batches = Array.from(
                { length: this.app.batchManager.simBatches },
                (_, i) => i
            );
            const diffControls = {
                diffLayer: this.app.uiState.terrainDiffLayer || diffLayers[0] || "height",
                diffBatchA: this.app.uiState.terrainDiffBatchA ?? 0,
                diffBatchB:
                    this.app.uiState.terrainDiffBatchB ??
                    Math.min(1, this.app.batchManager.simBatches - 1),
            };
            this.app.uiState.terrainDiffLayer = diffControls.diffLayer;
            this.app.uiState.terrainDiffBatchA = diffControls.diffBatchA;
            this.app.uiState.terrainDiffBatchB = diffControls.diffBatchB;

            diffLayerCtrl = this.terrainFolder
                .add(diffControls, "diffLayer", diffLayers)
                .name("Diff Layer")
                .onChange((value) => {
                    this.app.uiState.terrainDiffLayer = value;
                    this.refreshTerrainDiff();
                });
            diffBatchACtrl = this.terrainFolder
                .add(diffControls, "diffBatchA", batches)
                .name("Diff Batch A")
                .onChange((value) => {
                    this.app.uiState.terrainDiffBatchA = parseInt(value);
                    this.refreshTerrainDiff();
                });
            diffBatchBCtrl = this.terrainFolder
                .add(diffControls, "diffBatchB", batches)
                .name("Diff Batch B")
                .onChange((value) => {
                    this.app.uiState.terrainDiffBatchB = parseInt(value);
                    this.refreshTerrainDiff();
                });
        }
        this.diffControlsElements = [diffLayerCtrl, diffBatchACtrl, diffBatchBCtrl].filter(
            Boolean
        );
        this.updateDiffControlsVisibility(currentColorMode);

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

        cameraControls.copyViewLink = () => this.copyViewLink(copyViewLinkCtrl);
        const copyViewLinkCtrl = cameraFolder
            .add(cameraControls, "copyViewLink")
            .name("Copy view link");

        this.cameraControls = cameraControls;
        cameraFolder.close();

        if (this.app.metadata && Object.keys(this.app.metadata).length > 0) {
            this.metadataFolder = this.gui.addFolder("Scene Info");

            // Make a lil-gui string controller read-only, fully readable, and
            // click-to-copy. We deliberately do NOT call .disable() because
            // lil-gui injects `pointer-events:none !important` on the whole
            // .disabled row, blocking selection and click handlers.
            //
            // We also replace the <input> with a wrapping <div>: a single-line
            // <input> can only show as much text as its width allows, but a
            // <div> can wrap and grow so the whole value is always visible
            // without needing to scroll or copy it out to read it.
            const makeReadonlyCopyable = (ctrl, fullText) => {
                // Revert any edit attempt the user manages to trigger
                ctrl.onChange(() => ctrl.setValue(fullText));

                const input = ctrl.domElement.querySelector("input");
                if (!input) return;

                // Build a <div> that looks like the input but is scrollable
                const div = document.createElement("div");
                div.className = input.className + " simview-meta-input";
                div.title = "Click to copy";
                div.textContent = fullText;

                // Copy the inline styles lil-gui may have set on the input
                div.style.cssText = input.style.cssText;

                // Replace input in the DOM
                input.parentNode.replaceChild(div, input);

                // lil-gui's name label is `white-space:pre` with no wrap or
                // scroll, so a long key just silently overflows the panel
                // with no way to read the rest of it. Let it wrap instead.
                const name = ctrl.domElement.querySelector(".name");
                if (name) name.classList.add("simview-meta-name");

                div.addEventListener("click", () => {
                    navigator.clipboard.writeText(fullText).then(() => {
                        div.classList.remove("simview-meta-copied");
                        void div.offsetWidth; // force reflow to re-trigger animation
                        div.classList.add("simview-meta-copied");
                    }).catch(() => {
                        // Fallback: select all text in the div
                        const sel = window.getSelection();
                        const range = document.createRange();
                        range.selectNodeContents(div);
                        sel.removeAllRanges();
                        sel.addRange(range);
                    });
                });
            };

            // Helper: add one key/value row to a lil-gui folder.
            // Plain objects are broken out into a nested sub-folder so every
            // individual value is fully visible (no truncation needed) once
            // it's opened.
            const addMetaEntry = (folder, key, value) => {
                if (
                    value !== null &&
                    typeof value === "object" &&
                    !Array.isArray(value)
                ) {
                    // Nested object → sub-folder
                    const sub = folder.addFolder(key);
                    const subDisplay = {};
                    for (const [sk, sv] of Object.entries(value)) {
                        const fullText =
                            typeof sv === "string" ? sv : JSON.stringify(sv);
                        subDisplay[sk] = fullText;
                        const ctrl = sub.add(subDisplay, sk);
                        makeReadonlyCopyable(ctrl, fullText);
                    }
                    // Start collapsed: a scene with rich metadata otherwise
                    // dumps every nested key into the panel at once, which
                    // buries the top-level entries. The user opens what they
                    // actually want to read.
                    sub.close();
                } else {
                    const display = {};
                    const fullText =
                        typeof value === "string" ? value : JSON.stringify(value);
                    display[key] = fullText;
                    const ctrl = folder.add(display, key);
                    makeReadonlyCopyable(ctrl, fullText);
                }
            };

            for (const [key, value] of Object.entries(this.app.metadata)) {
                addMetaEntry(this.metadataFolder, key, value);
            }
            this.metadataFolder.close();
        }



        return this.gui;
    }

    // Builds the current view-state hash (see utils/viewState.js), writes it
    // to location.hash (via replaceState, so it doesn't spam browser history),
    // copies the full shareable URL to the clipboard, and gives transient
    // feedback on the button itself (label flips to "Copied!" for a beat).
    copyViewLink(controller) {
        const { camera, controls } = this.app.scene;
        const toggles = toggleMapFromUiState(this.app.uiState);
        const hash = serializeViewState({
            time: this.app.animationController ? this.app.animationController.getCurrentTime() : undefined,
            camera: {
                position: camera.position,
                target: controls.target,
                fov: camera.fov,
            },
            batchIndex: this.app.batchManager ? this.app.batchManager.currentlyActiveBatch : undefined,
            bodyVisualizationMode: this.app.uiState.bodyVisualizationMode,
            terrainColorMode: this.app.uiState.terrainColorMode,
            toggles,
        });

        history.replaceState(null, "", hash);
        const url = location.href;

        const showFeedback = (text) => {
            if (!controller) return;
            const originalName = "Copy view link";
            controller.name(text);
            setTimeout(() => controller.name(originalName), 1500);
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(
                () => showFeedback("Copied!"),
                () => this.#fallbackCopyToClipboard(url, showFeedback)
            );
        } else {
            this.#fallbackCopyToClipboard(url, showFeedback);
        }
    }

    // execCommand("copy") fallback for browsers/contexts without the async
    // Clipboard API (e.g. insecure contexts) -- a throwaway offscreen
    // textarea is the standard workaround.
    #fallbackCopyToClipboard(text, showFeedback) {
        try {
            const textarea = document.createElement("textarea");
            textarea.value = text;
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.focus();
            textarea.select();
            const ok = document.execCommand("copy");
            document.body.removeChild(textarea);
            showFeedback(ok ? "Copied!" : "Copy failed");
        } catch (e) {
            console.warn("Failed to copy view link to clipboard:", e);
            showFeedback("Copy failed");
        }
    }

    // Applies a decoded view-state's toggles/bodyVisualizationMode/
    // terrainColorMode (see utils/viewState.js + SimView.js's apply-on-load
    // hook) through this panel's own lil-gui controllers -- setValue() runs
    // each control's existing onChange handler (so e.g. body meshes actually
    // toggle their axes/trails/etc, exactly like a user clicking the
    // checkbox would) and refreshes the widget's on-screen display, so
    // lil-gui never drifts out of sync with uiState. Missing/unknown
    // controllers (e.g. an attribute not present in this scene) are
    // silently skipped -- this must tolerate a partial state.
    applyViewState(state) {
        if (!state || typeof state !== "object") return;

        if (typeof state.bodyVisualizationMode === "string") {
            const ctrl = this.findController("bodyVisualizationMode");
            if (ctrl && this.visualizationModes.includes(state.bodyVisualizationMode)) {
                ctrl.setValue(state.bodyVisualizationMode);
            }
        }

        if (typeof state.terrainColorMode === "string") {
            const ctrl = this.findController("colorMode");
            if (ctrl) ctrl.setValue(state.terrainColorMode);
        }

        if (state.toggles && typeof state.toggles === "object") {
            const propertyForKey = {
                axesVisible: "showAxes",
                trailsVisible: "showTrails",
                smoothInterpolation: "smoothInterpolation",
                terrainProbe: "terrainProbe",
                "attributeVisible.contacts": "showContacts",
                "attributeVisible.velocity": "showVelocity",
                "attributeVisible.angularVelocity": "showAngularVelocity",
                "attributeVisible.force": "showForce",
                "attributeVisible.torque": "showTorque",
                "terrainVisualizationModes.surface": "showSurface",
                "terrainVisualizationModes.wireframe": "showWireframe",
                "terrainVisualizationModes.normals": "showNormals",
            };
            Object.entries(propertyForKey).forEach(([stateKey, property]) => {
                if (!(stateKey in state.toggles)) return;
                const ctrl = this.findController(property);
                if (ctrl) ctrl.setValue(!!state.toggles[stateKey]);
            });
        }
    }

    setupKeyboardControls(app) {
        this.keyboardControlsListener = window.addEventListener(
            "keydown",
            (event) => {
                switch (event.key.toLowerCase()) {
                    case "b":
                        const modes = this.visualizationModes;
                        if (modes.length === 0) break;
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
                    case "i":
                        this.toggleControl("smoothInterpolation");
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
                        if (event.shiftKey) {
                            this.changeTargetBatch(event.key.toLowerCase());
                            event.stopPropagation();
                        }
                        break;
                }
            }
        );
    }

    // Searches every folder (Body/Terrain/Camera Options), not just
    // bodyFolder, so callers (keyboard shortcuts, and applyViewState below)
    // can find and setValue() any control -- setValue() both updates the
    // underlying uiState (via each controller's onChange) and refreshes the
    // widget's on-screen display, so this is the single path that keeps
    // lil-gui and uiState in sync.
    findController(property) {
        if (!this.gui) return null;
        for (const controller of this.gui.controllersRecursive()) {
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

    // Point-cloud bodies are outside Body Visualization Mode (see
    // Body#pointsVisible), so their visibility rides on this instead.
    updatePointCloudsVisibility(visible) {
        this.app.uiState.pointCloudsVisible = visible;
        this.app.bodies.forEach((body) => {
            if (body.setPointCloudsVisible) body.setPointCloudsVisible(visible);
        });
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

    updateSmoothInterpolation(enabled) {
        this.app.uiState.smoothInterpolation = enabled;
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

    // Shows the Diff Layer/Batch A/Batch B pickers only while Color Mode is
    // "diff" -- they're meaningless otherwise.
    updateDiffControlsVisibility(mode) {
        if (!this.diffControlsElements) return;
        for (const ctrl of this.diffControlsElements) {
            if (mode === "diff") ctrl.show();
            else ctrl.hide();
        }
    }

    // Re-renders the terrain diff overlay after the layer/batch-pair pickers
    // change, without going through the full setColorMode/setColorMap path
    // (the color *mode* itself -- "diff" -- hasn't changed, just which
    // layer/batches it diffs).
    refreshTerrainDiff() {
        if (this.app.terrain) {
            this.app.terrain.setColorMode("diff");
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
