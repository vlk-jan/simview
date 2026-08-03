import * as THREE from "three";
import { SELECTION_CONFIG, RAYCAST_CONFIG } from "../config.js";

export class InteractionController {
    constructor(app) {
        this.app = app;
        this.raycaster = new THREE.Raycaster();
        // Default THREE.Raycaster Points.threshold is 1 world unit -- far too
        // generous for points rendered at BODY_CONFIG.points.size (0.1), where
        // it would make every click ambiguous among many nearby points.
        this.raycaster.params.Points.threshold = RAYCAST_CONFIG.pointsThreshold;
        this.mouse = new THREE.Vector2();
        this.hoveredObject = null;
        this.selectedObject = null;

        this.isDragging = false;
        this.startPoint = { x: 0, y: 0 };
        this.selectionBox = null;

        this.currentSelectionMode = null;

        // Cache for getIntersectableObjects — rebuilt only when selection mode changes
        this._intersectableCache = null;
        this._intersectableCacheMode = null;
        // Reusable Vector3 for screen-projection in selection box
        this._projPoint = new THREE.Vector3();

        // Create the probe sphere
        const sphereGeo = new THREE.SphereGeometry(0.05, 16, 16);
        const sphereMat = new THREE.MeshBasicMaterial({ color: 0xff0000, depthTest: false });
        this.probeSphere = new THREE.Mesh(sphereGeo, sphereMat);
        this.probeSphere.renderOrder = 999; // Draw on top
        this.probeSphere.visible = false;
        if (this.app.scene) {
            this.app.scene.addObject3D(this.probeSphere);
        }

        // Bind methods to preserve context
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onClick = this.onClick.bind(this);
        this.handleHover = this.handleHover.bind(this);
        this.onMouseDown = this.onMouseDown.bind(this);
        this.onMouseDrag = this.onMouseDrag.bind(this);
        this.onMouseUp = this.onMouseUp.bind(this);
        this.onKeyUp = this.onKeyUp.bind(this);

        // handleHover does a full raycast; mousemove can fire far more often
        // than the display refreshes, so coalesce to at most one raycast per
        // animation frame instead of one per event.
        this._hoverRafId = null;
        this._queueHoverUpdate = () => {
            if (this._hoverRafId !== null) return;
            this._hoverRafId = requestAnimationFrame(() => {
                this._hoverRafId = null;
                this.handleHover();
            });
        };

        this.initializeEventListeners();
    }

    initializeEventListeners() {
        // Use passive event listeners where possible for better performance
        const passiveOptions = { passive: true };

        window.addEventListener("mousemove", this.onMouseMove, passiveOptions);
        window.addEventListener("click", this.onClick);
        window.addEventListener("keyup", this.onKeyUp);

        const renderer = this.app.scene && this.app.scene.renderer;
        if (!renderer) {
            console.warn("InteractionController: renderer not found during initialization.");
            return;
        }
        const canvas = renderer.domElement;
        if (!canvas) return;
        
        canvas.addEventListener("mousemove", this._queueHoverUpdate, passiveOptions);
        canvas.addEventListener("mousedown", this.onMouseDown);
        canvas.addEventListener("mousemove", this.onMouseDrag, passiveOptions);
        canvas.addEventListener("mouseup", this.onMouseUp);
    }

    cleanup() {
        // Remove event listeners when cleaning up
        window.removeEventListener("mousemove", this.onMouseMove);
        window.removeEventListener("click", this.onClick);
        window.removeEventListener("keyup", this.onKeyUp);

        const renderer = this.app.scene && this.app.scene.renderer;
        const canvas = renderer ? renderer.domElement : null;
        if (canvas) {
            canvas.removeEventListener("mousemove", this._queueHoverUpdate);
            canvas.removeEventListener("mousedown", this.onMouseDown);
            canvas.removeEventListener("mousemove", this.onMouseDrag);
            canvas.removeEventListener("mouseup", this.onMouseUp);
        }

        if (this._hoverRafId !== null) {
            cancelAnimationFrame(this._hoverRafId);
            this._hoverRafId = null;
        }

        this.clearSelectionBox();

        if (this.probeSphere && this.app.scene) {
            this.app.scene.removeObject3D(this.probeSphere);
            this.probeSphere.geometry.dispose();
            this.probeSphere.material.dispose();
            this.probeSphere = null;
        }
    }

    getSelectionMode(event) {
        for (const [mode, config] of Object.entries(SELECTION_CONFIG)) {
            if (event[`${config.key}Key`]) {
                return config;
            }
        }
        return null;
    }

    onMouseMove(e) {
        // Calculate mouse position in normalized device coordinates (-1 to +1)
        this.mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    }

    onClick(e) {
        if (!this.app.scene || !this.app.scene.camera) return;

        // Prevent click if mouse was dragged (e.g. rotating camera)
        if (this.lastMouseDown) {
            const dx = e.clientX - this.lastMouseDown.x;
            const dy = e.clientY - this.lastMouseDown.y;
            this.lastMouseDown = null; // Consume the mousedown
            if (dx * dx + dy * dy > 25) {
                return; // 5px movement threshold
            }
        }

        this.raycaster.setFromCamera(this.mouse, this.app.scene.camera);
        const intersects = this.raycaster.intersectObjects(
            // this.app.bodies is a Map (SimView.js), not a plain object --
            // Object.values() on a Map always returns [], which silently
            // made every click here a no-op until this fix. body.children
            // doesn't exist either (Body wraps a THREE.Group, exposed via
            // getObject3D()) -- filter includes isPoints too, so a click can
            // land on a rendered point cloud, not just mesh bodies.
            Array.from(this.app.bodies.values()).flatMap((body) =>
                body.getObject3D().children.filter((child) => child.isMesh || child.isPoints)
            ),
            true // Enable recursive raycasting
        );

        if (intersects.length > 0) {
            const hit = intersects[0];
            this.selectedObject = hit.object;
            // Mirrors the terrain gate below (features mode must already be
            // selected before a click does anything): similarity mode must
            // already be chosen from the "Point Color Mode" dropdown before
            // clicking recolors the cloud, not the other way around --
            // otherwise every accidental point click while in "pca" mode
            // would silently switch modes.
            if (
                hit.object.isPoints &&
                hit.object.userData?.bodyName &&
                this.app.uiState?.pointColorMode === "similarity"
            ) {
                this.#handlePointClick(hit);
            } else {
                this.hideTerrainTooltip();
            }
            return;
        }

        // Raycast against terrain
        if (this.app.uiState && this.app.uiState.terrainProbe && this.app.terrain && this.app.terrain.group) {
            const terrainIntersects = this.raycaster.intersectObject(this.app.terrain.group, true);
            const surfaceIntersect = terrainIntersects.find(i => i.object.name === "surface");
            if (surfaceIntersect) {
                if (this.app.uiState.terrainColorMode === "features") {
                    this.#handleTerrainFeatureClick(surfaceIntersect);
                } else {
                    this.showTerrainTooltip(e, surfaceIntersect);
                }
                return;
            }
        }

        this.hideTerrainTooltip();
    }

    // Point-cloud analog of showTerrainTooltip: recolors the whole body by
    // cosine similarity to the clicked point instead of showing a props
    // tooltip (there's no single "value" to display -- the whole point of
    // clicking is that every other point's similarity becomes visible).
    #handlePointClick(hit) {
        const body = this.app.bodies.get(hit.object.userData.bodyName);
        if (!body) return;
        body.recolorBySimilarity(hit.index);
        this.#hideTooltipText();
        if (this.probeSphere) {
            this.probeSphere.position.copy(hit.point);
            this.probeSphere.visible = true;
        }
    }

    // Terrain analog of #handlePointClick, used instead of showTerrainTooltip
    // when the BEV grid is in "features" color mode.
    #handleTerrainFeatureClick(intersect) {
        let batchIndex = 0;
        let current = intersect.object;
        while (current) {
            if (current.name && current.name.startsWith("batch")) {
                batchIndex = parseInt(current.name.replace("batch", ""));
                break;
            }
            current = current.parent;
        }
        if (!this.app.terrain.setFeatureQueryAt(intersect.point.x, intersect.point.y, batchIndex)) {
            this.hideTerrainTooltip();
            return;
        }
        this.#hideTooltipText();
        if (this.probeSphere) {
            this.probeSphere.position.copy(intersect.point);
            this.probeSphere.visible = true;
        }
    }

    showTerrainTooltip(e, intersect) {
        const point = intersect.point;
        let batchIndex = 0;
        let current = intersect.object;
        while (current) {
            if (current.name && current.name.startsWith("batch")) {
                batchIndex = parseInt(current.name.replace("batch", ""));
                break;
            }
            current = current.parent;
        }
        
        const props = this.app.terrain.getPropertiesAt(point.x, point.y, batchIndex);
        if (!props) return;

        let tooltip = document.getElementById("terrain-tooltip");
        if (!tooltip) {
            tooltip = document.createElement("div");
            tooltip.id = "terrain-tooltip";
            Object.assign(tooltip.style, {
                position: "absolute",
                background: "rgba(0, 0, 0, 0.8)",
                color: "white",
                padding: "8px",
                borderRadius: "4px",
                pointerEvents: "none",
                zIndex: "1000",
                fontSize: "12px",
                fontFamily: "monospace",
                whiteSpace: "pre"
            });
            document.body.appendChild(tooltip);
        }

        tooltip.style.left = `${e.clientX + 10}px`;
        tooltip.style.top = `${e.clientY + 10}px`;
        tooltip.style.display = "block";

        tooltip.innerText = this.#formatTerrainTooltip(point, batchIndex, props);

        if (this.probeSphere) {
            this.probeSphere.position.copy(point);
            this.probeSphere.visible = true;
        }
    }

    // Single-batch tooltip text: "Batch: N\nX: .., Y: ..\nHeight: ..." etc.
    // Used when the terrain is singleton (every batch shares the same data,
    // so showing all of them would just repeat the same numbers) or there's
    // only one batch to begin with.
    #formatSingleBatchProps(props) {
        let text = `Height: ${props.height.toFixed(3)}`;
        if (props.friction !== undefined) text += `\nFriction: ${props.friction.toFixed(3)}`;
        if (props.stiffness !== undefined) text += `\nStiffness: ${props.stiffness.toExponential(2)}`;
        return text;
    }

    // Builds the terrain probe tooltip text. For a non-singleton terrain
    // with 2+ batches, shows every batch's height/friction/stiffness plus,
    // for every batch other than the reference, its delta from the
    // reference batch (the Terrain Options "Diff Batch A" pick, or batch 0
    // if that's unset) -- so a DRIFT-style 4-batch scene shows all of
    // GT/baseline/pre/post at a glance instead of one at a time.
    #formatTerrainTooltip(point, batchIndex, props) {
        const header = `X: ${point.x.toFixed(3)}, Y: ${point.y.toFixed(3)}`;
        const simBatches = this.app.batchManager?.simBatches ?? 1;

        if (this.app.terrain.isSingleton || simBatches < 2) {
            return `Batch: ${batchIndex}\n${header}\n${this.#formatSingleBatchProps(props)}`;
        }

        const allProps = this.app.terrain.getPropertiesAtAllBatches(
            point.x,
            point.y,
            batchIndex
        );
        if (!allProps) {
            return `Batch: ${batchIndex}\n${header}\n${this.#formatSingleBatchProps(props)}`;
        }

        const referenceBatch = this.app.uiState?.terrainDiffBatchA ?? 0;
        const referenceProps = allProps.get(referenceBatch);

        const lines = [header];
        for (let i = 0; i < simBatches; i++) {
            const batchProps = allProps.get(i);
            if (!batchProps) continue;

            const isRef = i === referenceBatch;
            const label = `Batch ${i}${isRef ? " (ref)" : ""}${i === batchIndex ? " *" : ""}:`;
            const fields = [`h=${batchProps.height.toFixed(3)}`];
            if (batchProps.friction !== undefined) {
                fields.push(`fric=${batchProps.friction.toFixed(3)}`);
            }
            if (batchProps.stiffness !== undefined) {
                fields.push(`stiff=${batchProps.stiffness.toExponential(2)}`);
            }
            if (!isRef && referenceProps) {
                const dh = batchProps.height - referenceProps.height;
                fields.push(`Δh=${dh >= 0 ? "+" : ""}${dh.toFixed(3)}`);
                if (
                    batchProps.friction !== undefined &&
                    referenceProps.friction !== undefined
                ) {
                    const df = batchProps.friction - referenceProps.friction;
                    fields.push(`Δfric=${df >= 0 ? "+" : ""}${df.toFixed(3)}`);
                }
                if (
                    batchProps.stiffness !== undefined &&
                    referenceProps.stiffness !== undefined
                ) {
                    const ds = batchProps.stiffness - referenceProps.stiffness;
                    fields.push(`Δstiff=${ds >= 0 ? "+" : ""}${ds.toExponential(2)}`);
                }
            }
            lines.push(`${label} ${fields.join("  ")}`);
        }
        lines.push("(* = hovered batch)");
        return lines.join("\n");
    }

    // Just the DOM tooltip text -- split out of hideTerrainTooltip so a
    // point/terrain-feature click can hide the props tooltip without also
    // hiding the probe sphere it's about to reposition and show.
    #hideTooltipText() {
        const tooltip = document.getElementById("terrain-tooltip");
        if (tooltip) {
            tooltip.style.display = "none";
        }
    }

    hideTerrainTooltip() {
        this.#hideTooltipText();
        if (this.probeSphere) {
            this.probeSphere.visible = false;
        }
    }

    onMouseDown(e) {
        this.lastMouseDown = { x: e.clientX, y: e.clientY };
        
        this.currentSelectionMode = this.getSelectionMode(e);
        if (!this.currentSelectionMode) return;

        e.preventDefault(); // Prevent default only when needed
        this.isDragging = true;
        this.startPoint = {
            x: e.clientX,
            y: e.clientY,
        };

        this.initSelectionBox(e.clientX, e.clientY);
    }

    onMouseDrag(e) {
        if (!this.isDragging || !this.currentSelectionMode) {
            if (this.selectionBox) {
                this.clearSelectionBox();
            }
            return;
        }

        this.updateSelectionBox(e.clientX, e.clientY);
    }

    onMouseUp(e) {
        if (!this.isDragging) return;

        this.isDragging = false;
        if (e.ctrlKey) {
            this.selectObjectsInBox();
        }
        this.clearSelectionBox();
    }

    onKeyUp(e) {
        for (const config of Object.values(SELECTION_CONFIG)) {
            if (e.key === config.key) {
                this.isDragging = false;
                this.currentSelectionMode = null;
                this.clearSelectionBox();
                break;
            }
        }
    }
    initSelectionBox(x, y) {
        this.clearSelectionBox(); // Clear any existing selection box

        const overlay = document.createElement("div");
        Object.assign(overlay.style, {
            position: "fixed", // Using fixed instead of absolute
            border: "1px dashed #00ff00",
            backgroundColor: "rgba(0, 255, 0, 0.1)",
            pointerEvents: "none",
            left: `${x}px`,
            top: `${y}px`,
            width: "0px",
            height: "0px",
            zIndex: "1000",
        });

        document.body.appendChild(overlay);
        this.selectionBox = overlay;
    }

    updateSelectionBox(currentX, currentY) {
        if (!this.selectionBox) return;

        const width = currentX - this.startPoint.x;
        const height = currentY - this.startPoint.y;

        const left = width < 0 ? currentX : this.startPoint.x;
        const top = height < 0 ? currentY : this.startPoint.y;
        const absWidth = Math.abs(width);
        const absHeight = Math.abs(height);

        Object.assign(this.selectionBox.style, {
            left: `${left}px`,
            top: `${top}px`,
            width: `${absWidth}px`,
            height: `${absHeight}px`,
        });
    }

    clearSelectionBox() {
        if (this.selectionBox) {
            this.selectionBox.remove();
            this.selectionBox = null;
        }
    }

    handleHover() {
        if (!this.app.scene || !this.app.scene.camera) return;
        this.raycaster.setFromCamera(this.mouse, this.app.scene.camera);
        const intersectables = this.getIntersectableObjects();
        const intersects = this.raycaster.intersectObjects(intersectables, true);

        // Handle hover state
        const newHovered = intersects[0]?.object ?? null;
        if (this.hoveredObject !== newHovered) {
            if (this.hoveredObject) {
                this.onObjectUnhover(this.hoveredObject);
            }
            if (newHovered) {
                this.onObjectHover(newHovered);
            }
            this.hoveredObject = newHovered;
        }
    }

    onObjectHover(object) {
        object.scale.setScalar(1.2);
    }

    onObjectUnhover(object) {
        object.scale.setScalar(1.0);
    }

    getIntersectableObjects() {
        if (!this.currentSelectionMode) return [];

        const modeKey = this.currentSelectionMode.objects;
        if (this._intersectableCache && this._intersectableCacheMode === modeKey) {
            return this._intersectableCache;
        }

        const objects = this.app[modeKey];
        let result;
        if (modeKey === "bodies") {
            result = Object.values(objects)
                .flatMap((body) => body.children)
                .filter((child) => child.isMesh);
        } else {
            result = Object.values(objects);
        }
        this._intersectableCache = result;
        this._intersectableCacheMode = modeKey;
        return result;
    }

    invalidateIntersectableCache() {
        this._intersectableCache = null;
        this._intersectableCacheMode = null;
    }

    selectObjectsInBox() {
        if (!this.currentSelectionMode || !this.selectionBox) return;

        const camera = this.app.scene && this.app.scene.camera;
        const renderer = this.app.scene && this.app.scene.renderer;
        if (!camera || !renderer || !renderer.domElement) return;
        
        const rect = renderer.domElement.getBoundingClientRect();

        // Get the selection box coordinates
        const boxLeft = parseInt(this.selectionBox.style.left);
        const boxTop = parseInt(this.selectionBox.style.top);
        const boxWidth = parseInt(this.selectionBox.style.width);
        const boxHeight = parseInt(this.selectionBox.style.height);

        // Function to check if a point is inside the selection box
        const isPointInSelectionBox = (point) => {
            // Convert 3D point to screen coordinates (reuse _projPoint to avoid allocation)
            this._projPoint.copy(point).project(camera);

            // Convert to pixel coordinates
            const x = ((this._projPoint.x + 1) * rect.width) / 2 + rect.left;
            const y = ((-this._projPoint.y + 1) * rect.height) / 2 + rect.top;

            return (
                x >= boxLeft &&
                x <= boxLeft + boxWidth &&
                y >= boxTop &&
                y <= boxTop + boxHeight
            );
        };

        // Clear previous selection
        const selectionSet = this.app[this.currentSelectionMode.set];
        selectionSet.forEach((obj) => {
            if (obj.material) {
                obj.material.color.setHex(obj.originalColor || 0xffffff);
            }
        });
        selectionSet.clear();

        // Select objects (reuse bbox/center to avoid per-object allocations)
        const selectableObjects = this.getIntersectableObjects();
        const bbox = new THREE.Box3();
        const center = new THREE.Vector3();
        selectableObjects.forEach((object) => {
            bbox.setFromObject(object);
            bbox.getCenter(center);

            if (isPointInSelectionBox(center)) {
                if (!object.hasOwnProperty("originalColor")) {
                    object.originalColor = object.material.color.getHex();
                }
                object.material.color.setHex(0xff0000);
                selectionSet.add(object);
            }
        });

        console.log(
            `Selected ${selectionSet.size} ${this.currentSelectionMode.objects}`
        );
    }

    deselectAll() {
        for (const config of Object.values(SELECTION_CONFIG)) {
            const selectionSet = this.app[config.set];
            selectionSet.forEach((obj) => {
                if (obj.material && obj.hasOwnProperty("originalColor")) {
                    obj.material.color.setHex(obj.originalColor);
                }
            });
            selectionSet.clear();
        }
    }
}
