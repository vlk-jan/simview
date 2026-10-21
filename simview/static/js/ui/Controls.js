import { isEditableTarget } from "../utils/keyboard.js";
import { GUI } from "three/addons/libs/lil-gui.module.min.js";
import { colorMapOptions } from "../vendor/js-colormaps.js";
import { RENDER_ALL, RENDER_FOCUSED } from "../utils/batchVisibility.js";
import { serializeViewState } from "../utils/viewState.js";

// The lil-gui Controls panel (Body/Terrain/Camera Options, Scene Info) and
// its global keyboard shortcuts.
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

    // Which per-body attributes (contacts, velocity, ...) any body has.
    determineAttributeAvailability() {
        const attributeTypes = [
            "contacts",
            "velocity",
            "angularVelocity",
            "force",
            "torque",
        ];
        const bodies = [...this.app.bodies.values()];
        return Object.fromEntries(
            attributeTypes.map((type) => [type, bodies.some((body) => body.availableAttributes.has(type))])
        );
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

    trackableBodyNames() {
        return ["None", ...[...this.app.bodies].filter(([, b]) => b.hasPose).map(([n]) => n)];
    }

    // Body.hasPose is only settled once histories are appended (after this
    // GUI is built), so SimView.onStoreReady calls this to drop static point
    // clouds from Track Body. lil-gui's options() re-adds the controller at
    // the folder's end, so it's moved back into its original slot.
    updateTrackBodyOptions() {
        const old = this.trackBodyCtrl;
        if (!old) return;
        const next = old.domElement.nextSibling;
        const parent = old.domElement.parentNode;
        const names = this.trackableBodyNames();
        const ctrl = old.options(names).onChange((value) => {
            this.app.uiState.trackBody = value;
        });
        parent.insertBefore(ctrl.domElement, next);
        if (!names.includes(ctrl.getValue())) ctrl.setValue("None");
        this.trackBodyCtrl = ctrl;
    }

    determineHasPointClouds() {
        return [...this.app.bodies.values()].some((body) => body.isPointCloud);
    }

    // Shift+Arrow batch navigation: moves the active batch one cell on the
    // batch grid in the arrow's direction as seen from the camera, by snapping
    // the camera azimuth to the nearest grid axis.
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

    // Builds the whole panel from the scene's bodies, terrain and metadata,
    // seeding each control from uiState. Returns the GUI.
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
                showPolylines: this.app.uiState.polylinesVisible !== false,
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
                    .name(this.attributeAvailability.contacts ? "Show Point Clouds" : "Show Point Clouds (C)")
                    .onChange((value) => {
                        // Point-cloud bodies are outside Body Visualization Mode (see
                        // Body#pointsVisible), so their visibility rides on this instead.
                        this.app.uiState.pointCloudsVisible = value;
                        this.app.bodies.forEach((body) => {
                            if (body.setPointCloudsVisible) body.setPointCloudsVisible(value);
                        });
                    });
            }

            if (this.app.polylines?.length) {
                this.bodyFolder
                    .add(controls, "showPolylines")
                    .name("Show Polylines")
                    .onChange((value) => {
                        this.app.uiState.polylinesVisible = value;
                        this.app.polylines.forEach((p) => p.setVisible(value));
                    });
            }

            this.bodyFolder
                .add(controls, "showAxes")
                .name("Show Axes (A)")
                .onChange((value) => {
                    this.app.bodies.forEach((body) => body.toggleAxes(value));
                    this.app.uiState.axesVisible = value;
                });

            this.bodyFolder
                .add(controls, "showTrails")
                .name("Show Trails (G)")
                .onChange((value) => {
                    this.app.bodies.forEach((body) => body.toggleTrails(value));
                    this.app.uiState.trailsVisible = value;
                });

            this.bodyFolder
                .add(controls, "smoothInterpolation")
                .name("Smooth Interpolation (I)")
                .onChange((value) => {
                    this.app.uiState.smoothInterpolation = value;
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

            // Only create toggles for attributes actually present in the loaded data.
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

        // Terrain controls.
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
        // folder's splitBatchA/B show/hide-on-toggle pattern below.
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

        this.terrainFolder
            .add(terrainControls, "terrainProbe")
            .name("Data Probe (P)")
            .onChange((value) => {
                this.app.uiState.terrainProbe = value;
                if (!value && this.app.interactionController) {
                    this.app.interactionController.hideTerrainTooltip();
                }
            });

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
            this.trackBodyCtrl = cameraFolder
                .add(cameraControls, "trackBody", this.trackableBodyNames())
                .name("Track Body")
                .onChange((value) => {
                    this.app.uiState.trackBody = value;
                });
        }
            
        if (this.app.batchManager && this.app.batchManager.simBatches >= 2) {
            const batches = Array.from({length: this.app.batchManager.simBatches}, (_, i) => i);
            // In focused render mode the split batches are only drawn because
            // BatchManager pins them, so every change here must re-run its
            // visibility pass -- otherwise one half of the split stays blank.
            const refreshPins = () => this.app.batchManager.recomputeVisibleBatches();
            const splitScreenCtrl = cameraFolder.add(cameraControls, "splitScreen").name("Split Screen");
            const splitBatchACtrl = cameraFolder.add(cameraControls, "splitBatchA", batches).name("Split Batch A").onChange(v => {
                this.app.uiState.splitBatchA = parseInt(v);
                refreshPins();
            });
            const splitBatchBCtrl = cameraFolder.add(cameraControls, "splitBatchB", batches).name("Split Batch B").onChange(v => {
                this.app.uiState.splitBatchB = parseInt(v);
                refreshPins();
            });

            // Hide the batch selectors initially if splitScreen is off
            splitBatchACtrl.hide();
            splitBatchBCtrl.hide();

            splitScreenCtrl.onChange(v => {
                this.app.uiState.splitScreen = v;
                splitBatchACtrl.show(v);
                splitBatchBCtrl.show(v);
                refreshPins();
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

                // Build a <div> that looks like the input but wraps.
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
        const hash = serializeViewState(this.app.getViewState());

        history.replaceState(null, "", hash);
        const url = location.href;

        const showFeedback = (text) => {
            if (!controller) return;
            const originalName = "Copy view link";
            controller.name(text);
            setTimeout(() => controller.name(originalName), 1500);
        };

        navigator.clipboard.writeText(url).then(
            () => showFeedback("Copied!"),
            () => showFeedback("Copy failed")
        );
    }

    // Applies a decoded view state (see utils/viewState.js) through the
    // lil-gui controllers, so setValue() runs each onChange exactly as a click
    // would and the widgets stay in sync with uiState. Unknown keys and
    // controllers missing from this scene are skipped.
    applyViewState(state) {
        if (!state || typeof state !== "object") return;

        if (typeof state.bodyVisualizationMode === "string") {
            const ctrl = this.findController("bodyVisualizationMode");
            if (ctrl && this.visualizationModes.includes(state.bodyVisualizationMode)) {
                ctrl.setValue(state.bodyVisualizationMode);
            }
        }

        if (typeof state.terrainColorMode === "string") {
            // A link from a scene with a `friction` property opened on one
            // without it must not push an unknown mode into the dropdown.
            const ctrl = this.findController("colorMode");
            const known = this.app.terrain?.getAvailableColorModes() ?? [];
            if (ctrl && known.includes(state.terrainColorMode)) {
                ctrl.setValue(state.terrainColorMode);
            }
        }

        if (typeof state.terrainColorMap === "string") {
            const ctrl = this.findController("colorMap");
            if (ctrl && colorMapOptions.includes(state.terrainColorMap)) ctrl.setValue(state.terrainColorMap);
        }

        if (typeof state.pointCloudsVisible === "boolean") {
            const ctrl = this.findController("showPointClouds");
            if (ctrl) ctrl.setValue(state.pointCloudsVisible);
        }

        if (typeof state.trackBody === "string" && this.trackBodyCtrl) {
            if (this.trackableBodyNames().includes(state.trackBody)) this.trackBodyCtrl.setValue(state.trackBody);
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
                polylinesVisible: "showPolylines",
            };
            Object.entries(propertyForKey).forEach(([stateKey, property]) => {
                if (!(stateKey in state.toggles)) return;
                const ctrl = this.findController(property);
                if (ctrl) ctrl.setValue(!!state.toggles[stateKey]);
            });
        }
    }

    setupKeyboardControls(app) {
        // Plain toggles. Attribute controls (V/W/F/T) only exist when the
        // data has that attribute, so toggleControl's lookup is the guard.
        const toggleForKey = {
            a: "showAxes",
            g: "showTrails",
            i: "smoothInterpolation",
            v: "showVelocity",
            w: "showAngularVelocity",
            f: "showForce",
            t: "showTorque",
        };
        // Kept on the instance so dispose() can remove it.
        this.keyboardControlsListener = (event) => {
            if (isEditableTarget(event)) return;
            const key = event.key.toLowerCase();
            if (toggleForKey[key]) {
                this.toggleControl(toggleForKey[key]);
                return;
            }
            switch (key) {
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
                case "p":
                    if (!event.ctrlKey && !event.metaKey && !event.altKey)
                        this.toggleControl("terrainProbe");
                    break;
                case "c":
                    // Shared key: contacts win when the scene has them.
                    if (this.attributeAvailability.contacts)
                        this.toggleControl("showContacts");
                    else if (this.hasPointClouds)
                        this.toggleControl("showPointClouds");
                    break;
                case "arrowup":
                case "arrowdown":
                case "arrowleft":
                case "arrowright":
                    if (event.shiftKey) {
                        this.changeTargetBatch(event.key.toLowerCase());
                        // OrbitControls listens for keydown on this same
                        // window and treats Shift+Arrow as rotate; a sibling
                        // listener isn't stopped by stopPropagation, so this
                        // runs in the capture phase and stops immediately.
                        event.stopImmediatePropagation();
                    }
                    break;
            }
        };
        window.addEventListener("keydown", this.keyboardControlsListener, { capture: true });
    }

    // The controller bound to `property` in any folder, or null. Callers
    // setValue() through it so uiState (via onChange) and the widget stay in
    // sync.
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
        for (const ctrl of this.diffControlsElements) ctrl.show(mode === "diff");
    }

    // Re-runs setColorMode("diff") after the layer/batch-pair pickers change,
    // so the overlay and legend pick up the new layer/batches.
    refreshTerrainDiff() {
        if (this.app.terrain) {
            this.app.terrain.setColorMode("diff");
            if (this.app.legend) this.app.legend.update();
        }
    }

    dispose() {
        this.gui.destroy();
        this.gui = null;
        if (this.keyboardControlsListener) {
            window.removeEventListener("keydown", this.keyboardControlsListener, { capture: true });
            this.keyboardControlsListener = null;
        }
    }
}
