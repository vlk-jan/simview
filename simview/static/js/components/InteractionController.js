import * as THREE from "three";
import { SELECTION_CONFIG } from "../config.js";

export class InteractionController {
    constructor(app) {
        this.app = app;
        this.raycaster = new THREE.Raycaster();
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
        
        canvas.addEventListener("mousemove", this.handleHover, passiveOptions);
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
            canvas.removeEventListener("mousemove", this.handleHover);
            canvas.removeEventListener("mousedown", this.onMouseDown);
            canvas.removeEventListener("mousemove", this.onMouseDrag);
            canvas.removeEventListener("mouseup", this.onMouseUp);
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
            Object.values(this.app.bodies).flatMap((body) =>
                body.children.filter((child) => child.isMesh)
            ), // Filter only meshes
            true // Enable recursive raycasting
        );

        if (intersects.length > 0) {
            this.selectedObject = intersects[0].object;
            this.hideTerrainTooltip();
            return;
        }

        // Raycast against terrain
        if (this.app.uiState && this.app.uiState.terrainProbe && this.app.terrain && this.app.terrain.group) {
            const terrainIntersects = this.raycaster.intersectObject(this.app.terrain.group, true);
            const surfaceIntersect = terrainIntersects.find(i => i.object.name === "surface");
            if (surfaceIntersect) {
                this.showTerrainTooltip(e, surfaceIntersect);
                return;
            }
        }
        
        this.hideTerrainTooltip();
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
        
        let text = `Batch: ${batchIndex}\nX: ${point.x.toFixed(3)}, Y: ${point.y.toFixed(3)}\nHeight: ${props.height.toFixed(3)}`;
        if (props.friction !== undefined) text += `\nFriction: ${props.friction.toFixed(3)}`;
        if (props.stiffness !== undefined) text += `\nStiffness: ${props.stiffness.toExponential(2)}`;
        
        tooltip.innerText = text;

        if (this.probeSphere) {
            this.probeSphere.position.copy(point);
            this.probeSphere.visible = true;
        }
    }

    hideTerrainTooltip() {
        const tooltip = document.getElementById("terrain-tooltip");
        if (tooltip) {
            tooltip.style.display = "none";
        }
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
