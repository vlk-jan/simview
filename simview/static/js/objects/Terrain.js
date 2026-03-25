import * as THREE from "three";
import { TERRAIN_CONFIG } from "../config.js";
import { colorMapOptions, evaluate_cmap } from "../../lib/js-colormaps.js";

export class Terrain {
    constructor(terrainData, app) {
        this.app = app; // Store reference to app for accessing batch manager
        this.bounds = terrainData.bounds;
        this.dimensions = terrainData.dimensions;
        this.group = null;

        // Data normalization: Ensure heightData is array of arrays (batches)
        if (
            Array.isArray(terrainData.heightData) &&
            terrainData.heightData.length > 0 &&
            typeof terrainData.heightData[0] === "number"
        ) {
            console.debug("Normalizing flat heightData to single batch");
            terrainData.heightData = [terrainData.heightData];
        }
        this.heightData = terrainData.heightData;

        // Normalize frictionData
        if (
            Array.isArray(terrainData.frictionData) &&
            terrainData.frictionData.length > 0 &&
            typeof terrainData.frictionData[0] === "number"
        ) {
            terrainData.frictionData = [terrainData.frictionData];
        }
        this.frictionData = terrainData.frictionData;

        // Normalize stiffnessData
        if (
            Array.isArray(terrainData.stiffnessData) &&
            terrainData.stiffnessData.length > 0 &&
            typeof terrainData.stiffnessData[0] === "number"
        ) {
            terrainData.stiffnessData = [terrainData.stiffnessData];
        }
        this.stiffnessData = terrainData.stiffnessData;
        this.isSingleton = terrainData.isSingleton;

        // Data normalization: Ensure normals is array of arrays of vectors
        if (
            Array.isArray(terrainData.normals) &&
            terrainData.normals.length > 0
        ) {
            if (typeof terrainData.normals[0] === "number") {
                // Case: Flat array [x, y, z, x, y, z...]
                console.debug("Normalizing flat normals array to single batch of vectors");
                const flat = terrainData.normals;
                const vectors = [];
                for (let i = 0; i < flat.length; i += 3) {
                    vectors.push([flat[i], flat[i + 1], flat[i + 2]]);
                }
                terrainData.normals = [vectors];
            } else if (
                Array.isArray(terrainData.normals[0]) &&
                terrainData.normals[0].length > 0 &&
                typeof terrainData.normals[0][0] === "number"
            ) {
                // Case: Array of vectors [[x,y,z], ...] -> Wrap in batch
                console.debug("Normalizing list of normal vectors to single batch");
                terrainData.normals = [terrainData.normals];
            }
        }

        this.#createVisualRepresentations(
            this.heightData,
            terrainData.normals
        );
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
                    const [nx, ny, nz] = normals[dataIndex];

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

    #updateSurfaceColor(batchIndex, geometry, callableColormap) {
        if (!geometry) return;
        const position = geometry.attributes.position;
        const colorAttribute = geometry.attributes.color;
        if (!position || !colorAttribute) return;

        const { resolutionX, resolutionY } = this.dimensions;
        const mode = this.app.uiState.terrainColorMode || "height";

        // Update all colors based on the new colormap
        for (let i = 0; i < position.count; i++) {
            let value;
            if (mode === "height") {
                value = this.calculateNormalizedHeight(position.getZ(i));
            } else {
                const col = i % resolutionX;
                const invertedRow = Math.floor(i / resolutionX);
                const row = resolutionY - invertedRow - 1;
                const dataIndex = row * resolutionX + col;

                if (mode === "friction" && this.frictionData && this.frictionData[batchIndex]) {
                    // Friction is already [0, 1] from Sigmoid in the model
                    value = this.frictionData[batchIndex][dataIndex];
                    value = Math.max(0, Math.min(1, value));
                } else if (mode === "stiffness" && this.stiffnessData && this.stiffnessData[batchIndex]) {
                    // Normalize stiffness using a fixed range for comparison
                    // Model outputs range [10000, 500000], visualization uses [0, 500000]
                    const s = this.stiffnessData[batchIndex][dataIndex];
                    const stiffnessMax = 500000.0;
                    value = s / stiffnessMax;
                    value = Math.max(0, Math.min(1, value));
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
        return modes;
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
