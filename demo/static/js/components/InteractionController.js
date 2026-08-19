import * as THREE from "three";
import { RAYCAST_CONFIG } from "../config.js";

export class InteractionController {
    constructor(app) {
        this.app = app;
        this.raycaster = new THREE.Raycaster();
        // Default THREE.Raycaster Points.threshold is 1 world unit -- far too
        // generous for points rendered at BODY_CONFIG.points.size (0.1), where
        // it would make every click ambiguous among many nearby points.
        this.raycaster.params.Points.threshold = RAYCAST_CONFIG.pointsThreshold;
        this.mouse = new THREE.Vector2();
        this.selectedObject = null;

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
        this.onMouseDown = this.onMouseDown.bind(this);

        this.initializeEventListeners();
    }

    initializeEventListeners() {
        // Use passive event listeners where possible for better performance
        const passiveOptions = { passive: true };

        window.addEventListener("mousemove", this.onMouseMove, passiveOptions);
        window.addEventListener("click", this.onClick);

        const renderer = this.app.scene && this.app.scene.renderer;
        if (!renderer) {
            console.warn("InteractionController: renderer not found during initialization.");
            return;
        }
        const canvas = renderer.domElement;
        if (!canvas) return;

        // Only needed to tell a real click from the end of a camera drag --
        // see the movement-threshold check at the top of onClick.
        canvas.addEventListener("mousedown", this.onMouseDown);
    }

    cleanup() {
        // Remove event listeners when cleaning up
        window.removeEventListener("mousemove", this.onMouseMove);
        window.removeEventListener("click", this.onClick);

        const renderer = this.app.scene && this.app.scene.renderer;
        const canvas = renderer ? renderer.domElement : null;
        if (canvas) {
            canvas.removeEventListener("mousedown", this.onMouseDown);
        }

        if (this.probeSphere && this.app.scene) {
            this.app.scene.removeObject3D(this.probeSphere);
            this.probeSphere.geometry.dispose();
            this.probeSphere.material.dispose();
            this.probeSphere = null;
        }
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

        // Clicking is otherwise a no-op: there's nothing to probe (terrain
        // tooltip) or recolor (point similarity) unless the user has
        // explicitly opted into one of those two modes -- avoids any click
        // side effect (selecting a body, raycasting at all) while just
        // orbiting/navigating the scene. Toggling "Data Probe" off already
        // clears any existing tooltip itself (Controls.js), so there's
        // nothing left to clean up here.
        const probeActive = !!this.app.uiState?.terrainProbe;
        const similarityActive = this.app.uiState?.pointColorMode === "similarity";
        if (!probeActive && !similarityActive) return;

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

    // Formats a raw named-property value. Properties carry no unit/precision
    // metadata of their own, so this picks scientific notation for very
    // large or very small magnitudes (e.g. a stiffness ~1e5) and fixed
    // notation otherwise (e.g. a friction coefficient ~[0, 1]).
    #formatPropValue(value) {
        const abs = Math.abs(value);
        if (value !== 0 && (abs >= 1e4 || abs < 1e-3)) return value.toExponential(2);
        return value.toFixed(3);
    }

    // Single-batch tooltip text: "Batch: N\nX: .., Y: ..\nHeight: ..." etc.
    // Used when the terrain is singleton (every batch shares the same data,
    // so showing all of them would just repeat the same numbers) or there's
    // only one batch to begin with.
    #formatSingleBatchProps(props) {
        let text = `Height: ${props.height.toFixed(3)}`;
        for (const [name, value] of Object.entries(props)) {
            if (name === "height") continue;
            const label = name.charAt(0).toUpperCase() + name.slice(1);
            text += `\n${label}: ${this.#formatPropValue(value)}`;
        }
        return text;
    }

    // Builds the terrain probe tooltip text. For a non-singleton terrain
    // with 2+ batches, shows every batch's height and every named property
    // plus, for every batch other than the reference, its delta from the
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
        const propertyNames = Object.keys(props).filter((name) => name !== "height");

        const lines = [header];
        for (let i = 0; i < simBatches; i++) {
            const batchProps = allProps.get(i);
            if (!batchProps) continue;

            const isRef = i === referenceBatch;
            const label = `Batch ${i}${isRef ? " (ref)" : ""}${i === batchIndex ? " *" : ""}:`;
            const fields = [`h=${batchProps.height.toFixed(3)}`];
            for (const name of propertyNames) {
                if (batchProps[name] !== undefined) {
                    fields.push(`${name}=${this.#formatPropValue(batchProps[name])}`);
                }
            }
            if (!isRef && referenceProps) {
                const dh = batchProps.height - referenceProps.height;
                fields.push(`Δh=${dh >= 0 ? "+" : ""}${dh.toFixed(3)}`);
                for (const name of propertyNames) {
                    if (batchProps[name] === undefined || referenceProps[name] === undefined) {
                        continue;
                    }
                    const d = batchProps[name] - referenceProps[name];
                    fields.push(`Δ${name}=${d >= 0 ? "+" : ""}${this.#formatPropValue(d)}`);
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
    }
}
