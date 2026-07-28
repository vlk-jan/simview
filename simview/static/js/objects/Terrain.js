import * as THREE from "three";
import { TERRAIN_CONFIG } from "../config.js";
import { colorMapOptions, evaluate_cmap } from "../../lib/js-colormaps.js";

export class Terrain {
    constructor(terrainData, app) {
        this.app = app; // Store reference to app for accessing batch manager
        this.bounds = terrainData.bounds;
        this.dimensions = terrainData.dimensions;
        this.group = null;

        this.heightData = this.#normalizeScalarField(terrainData.heightData, true);
        this.frictionData = this.#normalizeScalarField(terrainData.frictionData);
        this.stiffnessData = this.#normalizeScalarField(terrainData.stiffnessData);
        this.isSingleton = terrainData.isSingleton;

        const normals = this.#normalizeNormals(terrainData.normals);

        this.#createVisualRepresentations(this.heightData, normals);
    }

    // Reshapes a flat Float32Array of `batchSize` concatenated per-vertex
    // records (`width` floats each) into one subarray view per batch.
    #splitIntoBatches(flatArray, width) {
        const batchSize = this.app.batchManager.simBatches;
        const resolution = this.dimensions.resolutionX * this.dimensions.resolutionY;
        const perBatch = resolution * width;
        const batches = [];
        for (let i = 0; i < batchSize; i++) {
            batches.push(flatArray.subarray(i * perBatch, (i + 1) * perBatch));
        }
        return batches;
    }

    // Normalizes a per-vertex scalar terrain field (heightData/frictionData/
    // stiffnessData) to an array of one entry per batch. Passes through
    // unchanged if already batched, or if absent (friction/stiffness are
    // optional).
    #normalizeScalarField(data, logNormalization = false) {
        if (data instanceof Float32Array) {
            return this.#splitIntoBatches(data, 1);
        }
        if (Array.isArray(data) && data.length > 0 && typeof data[0] === "number") {
            if (logNormalization) {
                console.debug("Normalizing flat heightData to single batch");
            }
            return [data];
        }
        return data;
    }

    // Normalizes terrain normals (per-vertex 3-vectors) to an array of one
    // batch of vectors.
    #normalizeNormals(data) {
        if (data instanceof Float32Array) {
            return this.#splitIntoBatches(data, 3);
        }
        if (Array.isArray(data) && data.length > 0) {
            if (typeof data[0] === "number") {
                // Case: Flat array [x, y, z, x, y, z...]
                console.debug("Normalizing flat normals array to single batch of vectors");
                const vectors = [];
                for (let i = 0; i < data.length; i += 3) {
                    vectors.push([data[i], data[i + 1], data[i + 2]]);
                }
                return [vectors];
            }
            if (
                Array.isArray(data[0]) &&
                data[0].length > 0 &&
                typeof data[0][0] === "number"
            ) {
                // Case: Array of vectors [[x,y,z], ...] -> Wrap in batch
                console.debug("Normalizing list of normal vectors to single batch");
                return [data];
            }
        }
        return data;
    }

    #createMaterials() {
        // Create materials for the surface and wireframe
        const surfaceMaterial = new THREE.MeshPhongMaterial({
            vertexColors: true,
            side: THREE.DoubleSide,
            flatShading: TERRAIN_CONFIG.flatShading || false,
            shininess: TERRAIN_CONFIG.shininess || 10,
        });

        const wireframeMaterial = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            wireframe: true,
            opacity: 0.2,
            transparent: true,
        });

        return { surfaceMaterial, wireframeMaterial };
    }

    #createVisualRepresentations(heightData, normals) {
        console.debug(
            `Creating terrain geometry: ${this.dimensions.sizeX}x${this.dimensions.sizeY} m, resolution: ${this.dimensions.resolutionX}x${this.dimensions.resolutionY}`
        );
        const { surfaceMaterial, wireframeMaterial } = this.#createMaterials();

        let singletonSurfaceGeometry = null;
        let singletonNormals = null;

        if (this.isSingleton) {
            singletonSurfaceGeometry = this.#createSurfaceGeometryFromHeightData(
                heightData[0],
                0
            );
            singletonNormals = this.#createNormalVectors(
                heightData[0],
                normals[0]
            );
        }

        // Create geometry for each batch
        this.group = new THREE.Group();
        for (let i = 0; i < this.app.batchManager.simBatches; i++) {
            const batchGroup = new THREE.Group();
            batchGroup.name = `batch${i}`;

            const surfaceGeometry = this.isSingleton
                ? singletonSurfaceGeometry
                : this.#createSurfaceGeometryFromHeightData(heightData[i], i);

            const surfaceMesh = new THREE.Mesh(surfaceGeometry, surfaceMaterial);
            surfaceMesh.name = "surface";
            surfaceMesh.receiveShadow = true;
            surfaceMesh.castShadow = true;
            batchGroup.add(surfaceMesh);

            const wireframeMesh = new THREE.Mesh(surfaceGeometry, wireframeMaterial);
            wireframeMesh.name = "wireframe";
            batchGroup.add(wireframeMesh);

            const surfaceNormals = this.isSingleton
                ? singletonNormals.clone()
                : this.#createNormalVectors(heightData[i], normals[i]);

            surfaceNormals.name = "normals";
            batchGroup.add(surfaceNormals);

            for (const [key, value] of Object.entries(
                this.app.uiState.terrainVisualizationModes
            )) {
                const obj = batchGroup.getObjectByName(key);
                if (obj) obj.visible = value;
            }
            // translate by the batch offset
            const batch_offset = this.app.batchManager.getBatchOffset(i);
            batchGroup.position.set(batch_offset.x, batch_offset.y, batch_offset.z);
            this.group.add(batchGroup);
        }
    }

    // Normalize a value into [0, 1] against an explicit [min, max] range.
    // Falls back to [0, 1] clamping when the range is missing or degenerate.
    #normalizeToRange(value, min, max) {
        if (
            typeof min !== "number" ||
            typeof max !== "number" ||
            max - min === 0
        ) {
            return Math.max(0, Math.min(1, value));
        }
        const normalized = (value - min) / (max - min);
        return Math.max(0, Math.min(1, normalized));
    }

    calculateNormalizedHeight(height) {
        var normalizedHeight =
            (height - this.bounds.minZ) / (this.bounds.maxZ - this.bounds.minZ);
        normalizedHeight = Number.isFinite(normalizedHeight) ? normalizedHeight : 0;
        normalizedHeight = Math.max(0, Math.min(1, normalizedHeight));
        return normalizedHeight;
    }

    /**
     *
     * @param {array} heightData - Height data for the terrain, a flattened array
     * @returns
     */
    #createSurfaceGeometryFromHeightData(heightData, batchIndex) {
        const { sizeX, sizeY, resolutionX, resolutionY } = this.dimensions;
        const { minX, minY, maxX, maxY } = this.bounds;
        // Create a plane geometry with the right number of segments
        const geometry = new THREE.PlaneGeometry(
            sizeX,
            sizeY,
            resolutionX - 1,
            resolutionY - 1
        );
        // Center the geometry based on bounds
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        geometry.translate(centerX, centerY, 0);
        // Get attributes for direct manipulation
        const position = geometry.attributes.position;
        // Create color buffer
        const colorAttribute = new THREE.BufferAttribute(
            new Float32Array(position.count * 3),
            3
        );
        geometry.setAttribute("color", colorAttribute);

        // Apply height data to geometry
        // NOTE: THREE.js PlaneGeometry vertices are arranged in rows from bottom to top (Y increases)
        const callableColormap = this.getCallableFromColorMapName(
            this.app.uiState.terrainColorMap
        );

        for (let i = 0; i < position.count; i++) {
            // Convert vertex index to grid coordinates
            const col = i % resolutionX;
            const invertedRow = Math.floor(i / resolutionX);
            const row = resolutionY - invertedRow - 1; // Invert row index
            // Calculate index in the flattened height data array
            const dataIndex = row * resolutionX + col;
            // Set Z coordinate (height)
            position.setZ(i, heightData[dataIndex]);
        }

        // Apply colors
        this.#updateSurfaceColor(batchIndex, geometry, callableColormap);

        // Make sure changes are applied
        position.needsUpdate = true;
        return geometry;
    }

    getCallableFromColorMapName(cmapName) {
        let reversed = false;
        // Check if this is a reversed colormap request
        if (cmapName.endsWith("_r")) {
            cmapName = cmapName.substring(0, cmapName.length - 2);
            reversed = true;
        }
        if (colorMapOptions.includes(cmapName))
            return (value) => {
                const [r, g, b] = evaluate_cmap(value, cmapName, reversed);
                return new THREE.Color(r / 255, g / 255, b / 255);
            };
        console.log(
            `Colormap ${cmapName} not found in colorMapOptions. Using default colormap instead.`
        );
        // Fallback
        switch (cmapName) {
            case "grayscale":
                return (value) => new THREE.Color(value, value, value);
            case "heatmap":
                // Simple heatmap: blue->cyan->green->yellow->red
                return (value) => {
                    if (value < 0.25) {
                        return new THREE.Color(0, value * 4, 1);
                    } else if (value < 0.5) {
                        return new THREE.Color(0, 1, 1 - (value - 0.25) * 4);
                    } else if (value < 0.75) {
                        return new THREE.Color((value - 0.5) * 4, 1, 0);
                    } else {
                        return new THREE.Color(1, 1 - (value - 0.75) * 4, 0);
                    }
                };
            case "terrain":
                // Terrain color map - blues for low areas, greens for middle, browns/whites for high
                return (value) => {
                    if (value < 0.2) {
                        return new THREE.Color(0.0, 0.2, 0.5 + value); // Deep to shallow water
                    } else if (value < 0.4) {
                        const t = (value - 0.2) * 5; // 0-1 within this range
                        return new THREE.Color(0.2 * t, 0.5 + 0.2 * t, 0.7 - 0.2 * t); // Shore transition
                    } else if (value < 0.75) {
                        const t = (value - 0.4) / 0.35; // 0-1 within this range
                        return new THREE.Color(0.2 + 0.3 * t, 0.7 - 0.2 * t, 0.5 - 0.4 * t); // Green to brown
                    } else {
                        const t = (value - 0.75) * 4; // 0-1 within this range
                        return new THREE.Color(0.5 + 0.5 * t, 0.5 + 0.5 * t, 0.1 + 0.9 * t); // Brown to white (snow)
                    }
                };
            default:
                // Default blue to red gradient
                return (value) => new THREE.Color(value, 0.2, 1 - value);
        }
    }

    /**
     *
     * @param {array} heightData - Height data for the terrain, a flattened array
     * @param {array} normals - Normal data for the terrain, an array of 3D vectors
     * @returns {THREE.Group} - Group containing normal vectors
     */
    #createNormalVectors(heightData, normals) {
        const { sizeX, sizeY, resolutionX, resolutionY } = this.dimensions;
        const { minX, minY } = this.bounds;

        const normalVectors = new THREE.Group();
        normalVectors.visible =
            this.app.uiState.terrainVisualizationModes.normals || false;

        // Create a helper arrow for each normal
        const normalLength = TERRAIN_CONFIG.normalLength || 0.5;
        const skipFactor = Math.max(
            1,
            Math.floor(resolutionX / TERRAIN_CONFIG.skipNormalCells)
        ); // Adaptive skip factor based on resolution

        // Sample normals at regular intervals
        for (let row = 0; row < resolutionY; row += skipFactor) {
            for (let col = 0; col < resolutionX; col += skipFactor) {
                const dataIndex = row * resolutionX + col;

                if (dataIndex < heightData.length) {
                    // Calculate real-world coordinates
                    const x = minX + col * (sizeX / (resolutionX - 1));
                    const y = minY + row * (sizeY / (resolutionY - 1));
                    const z = heightData[dataIndex];

                    // Get normal data
                    let nx, ny, nz;
                    if (normals instanceof Float32Array) {
                        nx = normals[dataIndex * 3];
                        ny = normals[dataIndex * 3 + 1];
                        nz = normals[dataIndex * 3 + 2];
                    } else {
                        [nx, ny, nz] = normals[dataIndex];
                    }

                    const origin = new THREE.Vector3(x, y, z);
                    const direction = new THREE.Vector3(nx, ny, nz);

                    const arrowHelper = new THREE.ArrowHelper(
                        direction.normalize(),
                        origin,
                        normalLength,
                        0xff0000
                    );

                    normalVectors.add(arrowHelper);
                }
            }
        }
        return normalVectors;
    }

    // Toggle methods for visualizations - now updated to support batched terrains
    toggleVisualization(type, visible) {
        // Toggle in the original terrain
        for (const batchGroup of this.group.children) {
            const object = batchGroup.getObjectByName(type);
            if (object) {
                object.visible = visible;
            }
        }
    }

    // Returns the per-batch data array for a diff layer name ("height",
    // "friction", or "stiffness").
    #diffLayerData(layer) {
        if (layer === "friction") return this.frictionData;
        if (layer === "stiffness") return this.stiffnessData;
        return this.heightData;
    }

    // Largest absolute (batchB - batchA) delta over the whole grid for a
    // diff layer, used to scale the diverging colormap so it's centered on
    // zero. Returns 0 (rather than dividing by zero downstream) if the data
    // is missing or the two batches are identical -- callers treat 0 as "no
    // delta to show".
    #maxAbsDelta(layer, batchA, batchB) {
        const data = this.#diffLayerData(layer);
        const a = data && data[batchA];
        const b = data && data[batchB];
        if (!a || !b) return 0;
        let max = 0;
        for (let i = 0; i < a.length; i++) {
            const abs = Math.abs(b[i] - a[i]);
            if (abs > max) max = abs;
        }
        return max;
    }

    #updateSurfaceColor(batchIndex, geometry, callableColormap) {
        if (!geometry) return;
        const position = geometry.attributes.position;
        const colorAttribute = geometry.attributes.color;
        if (!position || !colorAttribute) return;

        const { resolutionX, resolutionY } = this.dimensions;
        const mode = this.app.uiState.terrainColorMode || "height";

        let diffLayer, diffBatchA, diffBatchB, diffLayerData, maxAbsDelta;
        if (mode === "diff") {
            // Diff mode always renders with a fixed diverging colormap
            // (centered on zero), independent of the sequential "Color Map"
            // picker used by height/friction/stiffness -- see Legend.js's
            // matching "diff" branch.
            callableColormap = this.getCallableFromColorMapName("coolwarm");
            diffLayer = this.app.uiState.terrainDiffLayer || "friction";
            diffBatchA = this.app.uiState.terrainDiffBatchA ?? 0;
            diffBatchB =
                this.app.uiState.terrainDiffBatchB ??
                Math.min(1, this.app.batchManager.simBatches - 1);
            diffLayerData = this.#diffLayerData(diffLayer);
            maxAbsDelta = this.#maxAbsDelta(diffLayer, diffBatchA, diffBatchB);
        }

        // Update all colors based on the new colormap
        for (let i = 0; i < position.count; i++) {
            let value;
            if (mode === "diff") {
                const col = i % resolutionX;
                const invertedRow = Math.floor(i / resolutionX);
                const row = resolutionY - invertedRow - 1;
                const dataIndex = row * resolutionX + col;

                const a = diffLayerData && diffLayerData[diffBatchA];
                const b = diffLayerData && diffLayerData[diffBatchB];
                if (a && b && maxAbsDelta > 0) {
                    const delta = b[dataIndex] - a[dataIndex];
                    value = 0.5 + 0.5 * Math.max(-1, Math.min(1, delta / maxAbsDelta));
                } else {
                    value = 0.5; // no delta (or missing data): render as the center color
                }
            } else if (mode === "height") {
                value = this.calculateNormalizedHeight(position.getZ(i));
            } else {
                const col = i % resolutionX;
                const invertedRow = Math.floor(i / resolutionX);
                const row = resolutionY - invertedRow - 1;
                const dataIndex = row * resolutionX + col;

                if (mode === "friction" && this.frictionData && this.frictionData[batchIndex]) {
                    // Normalize against the data range shipped in bounds (falls back to [0, 1]).
                    value = this.#normalizeToRange(
                        this.frictionData[batchIndex][dataIndex],
                        this.bounds.minFriction,
                        this.bounds.maxFriction
                    );
                } else if (mode === "stiffness" && this.stiffnessData && this.stiffnessData[batchIndex]) {
                    // Normalize against the data range shipped in bounds (falls back to [0, 1]).
                    value = this.#normalizeToRange(
                        this.stiffnessData[batchIndex][dataIndex],
                        this.bounds.minStiffness,
                        this.bounds.maxStiffness
                    );
                } else {
                    value = this.calculateNormalizedHeight(position.getZ(i));
                }
            }
            const color = callableColormap(value);
            colorAttribute.setXYZ(i, color.r, color.g, color.b);
        }
        // Update the buffer
        colorAttribute.needsUpdate = true;
    }

    // Max |delta| for the currently-configured diff layer/batch pair, for
    // Legend.js to label the diverging colorbar's endpoints.
    getDiffMaxAbsDelta() {
        const layer = this.app.uiState.terrainDiffLayer || "friction";
        const batchA = this.app.uiState.terrainDiffBatchA ?? 0;
        const batchB =
            this.app.uiState.terrainDiffBatchB ??
            Math.min(1, this.app.batchManager.simBatches - 1);
        return this.#maxAbsDelta(layer, batchA, batchB);
    }

    // Update terrain colors with current colormap
    setColorMap(colormapName) {
        // Update the main terrain surface
        const callableColormap = this.getCallableFromColorMapName(colormapName);
        const batchesToUpdate = this.isSingleton ? 1 : this.app.batchManager.simBatches;

        for (let i = 0; i < batchesToUpdate; i++) {
            const batchGroup = this.group.getObjectByName(`batch${i}`);
            const surfaceMesh = batchGroup.getObjectByName("surface");
            const geometry = surfaceMesh.geometry;
            this.#updateSurfaceColor(i, geometry, callableColormap);
        }
    }

    // Update terrain colors with current mode
    setColorMode(mode) {
        const callableColormap = this.getCallableFromColorMapName(this.app.uiState.terrainColorMap);
        const batchesToUpdate = this.isSingleton ? 1 : this.app.batchManager.simBatches;

        for (let i = 0; i < batchesToUpdate; i++) {
            const batchGroup = this.group.getObjectByName(`batch${i}`);
            const surfaceMesh = batchGroup.getObjectByName("surface");
            const geometry = surfaceMesh.geometry;
            this.#updateSurfaceColor(i, geometry, callableColormap);
        }
    }

    getAvailableColorModes() {
        const modes = [];
        if (this.heightData && this.heightData.length > 0) {
            modes.push("height");
        }
        if (this.frictionData && this.frictionData.length > 0) {
            modes.push("friction");
        }
        if (this.stiffnessData && this.stiffnessData.length > 0) {
            modes.push("stiffness");
        }
        if (this.app.batchManager.simBatches >= 2) {
            modes.push("diff");
        }
        return modes;
    }

    // Layer names ("height"/"friction"/"stiffness") with per-batch data
    // present, for the diff mode's layer picker in Controls.js.
    getAvailableDiffLayers() {
        return this.getAvailableColorModes().filter((mode) => mode !== "diff");
    }

    // Resolves a world-space (x, y) point -- clicked/hovered on
    // `spatialBatchIndex`'s own terrain patch, hence that batch's world
    // offset is what maps it back to local grid coordinates -- to a grid
    // (col, row) index. Returns `null` if the point falls outside the
    // terrain extent (or off the grid after rounding).
    #resolveGridIndex(x, y, spatialBatchIndex) {
        const batchOffset = this.app.batchManager.getBatchOffset(spatialBatchIndex);
        const localX = x - batchOffset.x;
        const localY = y - batchOffset.y;

        const { sizeX, sizeY, resolutionX, resolutionY } = this.dimensions;
        const { minX, minY, maxX, maxY } = this.bounds;

        if (localX < minX || localX > maxX || localY < minY || localY > maxY) {
            return null;
        }

        const col = Math.round(((localX - minX) / sizeX) * (resolutionX - 1));
        const row = Math.round(((localY - minY) / sizeY) * (resolutionY - 1));
        if (col < 0 || col >= resolutionX || row < 0 || row >= resolutionY) return null;

        return row * this.dimensions.resolutionX + col;
    }

    // Reads height/friction/stiffness for `dataBatchIndex` at an already-
    // resolved flat grid index (see #resolveGridIndex). Shared by
    // getPropertiesAt and getPropertiesAtAllBatches so both look up data the
    // same way.
    #propsAtIndex(dataIndex, dataBatchIndex) {
        const props = {};
        if (this.heightData && this.heightData[dataBatchIndex]) {
            props.height = this.heightData[dataBatchIndex][dataIndex];
        } else {
            return null;
        }
        if (this.frictionData && this.frictionData[dataBatchIndex]) {
            props.friction = this.frictionData[dataBatchIndex][dataIndex];
        }
        if (this.stiffnessData && this.stiffnessData[dataBatchIndex]) {
            props.stiffness = this.stiffnessData[dataBatchIndex][dataIndex];
        }
        return props;
    }

    getPropertiesAt(x, y, batchIndex) {
        const dataIndex = this.#resolveGridIndex(x, y, batchIndex);
        if (dataIndex === null) return null;
        const dataBatchIndex = this.isSingleton ? 0 : batchIndex;
        return this.#propsAtIndex(dataIndex, dataBatchIndex);
    }

    // Like getPropertiesAt, but returns every batch's properties at the same
    // grid cell -- the world point `(x, y)` was clicked/hovered on
    // `hoveredBatchIndex`'s terrain patch (batches are laid out side by side
    // in world space, each at its own offset), so that's the one used to
    // resolve the point to a grid cell; every other batch's value at that
    // *same* cell is then read directly, without re-applying its own world
    // offset to the original point (which would incorrectly re-project it
    // onto a different patch entirely). Returns `null` if the point is
    // outside the terrain extent; otherwise a `Map<batchIndex, props>`
    // (batches whose data lookup fails, e.g. a missing field, are omitted).
    getPropertiesAtAllBatches(x, y, hoveredBatchIndex) {
        const dataIndex = this.#resolveGridIndex(x, y, hoveredBatchIndex);
        if (dataIndex === null) return null;

        const simBatches = this.app.batchManager.simBatches;
        const result = new Map();
        for (let i = 0; i < simBatches; i++) {
            const dataBatchIndex = this.isSingleton ? 0 : i;
            const props = this.#propsAtIndex(dataIndex, dataBatchIndex);
            if (props) result.set(i, props);
        }
        return result;
    }

    // Get THREE.js group containing all visualizations
    getObject3D() {
        return this.group;
    }

    // Clean up resources when terrain is no longer needed
    dispose() {
        const geometries = new Set();
        const materials = new Set();

        for (const batchGroup of this.group.children) {
            batchGroup.traverse((child) => {
                if (child.geometry) geometries.add(child.geometry);
                if (child.material) {
                    if (Array.isArray(child.material)) {
                        child.material.forEach((m) => materials.add(m));
                    } else {
                        materials.add(child.material);
                    }
                }
            });
            if (this.app && this.app.scene) {
                this.app.scene.removeObject3D(batchGroup);
            }
        }

        geometries.forEach((g) => g.dispose());
        materials.forEach((m) => m.dispose());
        this.group = null;
    }
}
