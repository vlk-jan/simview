import * as THREE from "three";
import { TERRAIN_CONFIG } from "../config.js";
import { getCallableFromColorMapName as resolveColorMap } from "./colormap.js";

export class Terrain {
    constructor(terrainData, app) {
        this.app = app; // Store reference to app for accessing batch manager
        this.bounds = terrainData.bounds;
        this.dimensions = terrainData.dimensions;
        this.group = null;

        // Set before any field is normalized: #initEmbeddingData needs it to
        // resolve the shared-vs-per-batch layout of a singleton terrain.
        this.isSingleton = terrainData.isSingleton;
        this.heightData = this.#normalizeScalarField(terrainData.heightData, true);
        this.#initProperties(terrainData.properties);
        this.#initEmbeddingData(terrainData.embeddingData);

        const normals = this.#normalizeVectorField(terrainData.normals, 3);

        this.#createVisualRepresentations(this.heightData, normals);
    }

    // Reserved color-mode names a property can't be named after -- picking
    // one of these would make getAvailableColorModes/#updateSurfaceColor
    // ambiguous between the built-in mode and the named property.
    static #RESERVED_MODE_NAMES = new Set(["height", "diff", "features"]);

    // Populates this.properties (name -> per-batch data) and
    // this.propertyBounds (name -> {min, max}) from the server's arbitrary
    // named `properties` bag (see SimViewTerrain.properties/TerrainProperty
    // in model.py). Any number of properties (e.g. friction, stiffness, or
    // any custom name) become selectable terrain color modes automatically,
    // with no viewer code changes.
    #initProperties(propertiesData) {
        this.properties = new Map();
        this.propertyBounds = new Map();
        for (const [name, prop] of Object.entries(propertiesData || {})) {
            if (Terrain.#RESERVED_MODE_NAMES.has(name)) {
                console.warn(
                    `Terrain property '${name}' collides with a reserved color mode name and will be ignored.`
                );
                continue;
            }
            this.properties.set(name, this.#normalizeScalarField(prop.data));
            this.propertyBounds.set(name, { min: prop.min, max: prop.max });
        }
    }

    // Per-cell K-wide feature vector (e.g. a reduced-dim PCA projection of a
    // learned backbone's features), enabling the "features" click-to-
    // similarity color mode. Unlike normals (fixed width=3), K is
    // data-driven -- inferred from the flat blob length, the same implicit-
    // width convention Body.js uses for point embeddings -- rather than
    // shipped explicitly. Real producers always blob-encode this (so it
    // always arrives as a flat Float32Array), so unlike
    // #normalizeVectorField this doesn't need to handle hand-authored
    // nested-list-of-vectors input.
    #initEmbeddingData(embeddingData) {
        const resolution = this.dimensions.resolutionX * this.dimensions.resolutionY;
        if (embeddingData instanceof Float32Array) {
            const batchCount = this.#embeddingBatchCount(embeddingData, resolution);
            this.embeddingDim = embeddingData.length / (batchCount * resolution);
            this.embeddingData = this.#splitIntoBatches(embeddingData, this.embeddingDim);
        } else if (
            Array.isArray(embeddingData) &&
            embeddingData.length > 0 &&
            typeof embeddingData[0] === "number"
        ) {
            this.embeddingDim = embeddingData.length / resolution;
            this.embeddingData = [embeddingData]; // flat number array => single batch
        } else {
            this.embeddingDim = 0;
            this.embeddingData = null;
        }
    }

    // Reshapes a flat Float32Array of concatenated per-vertex records
    // (`width` floats each) into one subarray view per batch. The batch
    // count is inferred from the data length rather than taken from
    // simBatches: a singleton terrain ships exactly one shared copy
    // (resolution-sized), while per-batch (or legacy broadcast-singleton)
    // data holds simBatches copies -- both split correctly this way.
    #splitIntoBatches(flatArray, width) {
        const resolution = this.dimensions.resolutionX * this.dimensions.resolutionY;
        const perBatch = resolution * width;
        const count = Math.max(1, Math.round(flatArray.length / perBatch));
        const batches = [];
        for (let i = 0; i < count; i++) {
            batches.push(flatArray.subarray(i * perBatch, (i + 1) * perBatch));
        }
        return batches;
    }

    // How many batches an embedding blob spans. Unlike heightData/normals,
    // the per-cell width K isn't known up front (it's inferred from the flat
    // length), so a singleton blob whose total length happens to divide by
    // simBatches is ambiguous between one shared row (K wide) and simBatches
    // legacy broadcast copies (K/simBatches wide each). Identical chunks
    // mean broadcast copies; any difference means one shared row.
    #embeddingBatchCount(flat, resolution) {
        const simBatches = this.app.batchManager.simBatches;
        if (!this.isSingleton) return simBatches;
        if (flat.length % (simBatches * resolution) !== 0) return 1;
        const perBatch = flat.length / simBatches;
        for (let b = 1; b < simBatches; b++) {
            for (let i = 0; i < perBatch; i++) {
                if (flat[i] !== flat[b * perBatch + i]) return 1;
            }
        }
        return simBatches;
    }

    // Normalizes a per-vertex scalar terrain field (heightData, or a named
    // property's data) to an array of one entry per batch. Passes through
    // unchanged if already batched, or if absent (named properties are
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

    // Normalizes a per-vertex width-wide vector field (normals: width=3;
    // embedding: width=K, see #initEmbeddingData) to an array of one batch
    // of vectors.
    #normalizeVectorField(data, width) {
        if (data instanceof Float32Array) {
            return this.#splitIntoBatches(data, width);
        }
        if (Array.isArray(data) && data.length > 0) {
            if (typeof data[0] === "number") {
                // Case: Flat array [x, y, z, x, y, z...]
                console.debug(
                    `Normalizing flat vector field (width=${width}) to single batch of vectors`
                );
                const vectors = [];
                for (let i = 0; i < data.length; i += width) {
                    vectors.push(data.slice(i, i + width));
                }
                return [vectors];
            }
            if (
                Array.isArray(data[0]) &&
                data[0].length > 0 &&
                typeof data[0][0] === "number"
            ) {
                // Case: Array of vectors [[x,y,z], ...] -> Wrap in batch
                console.debug("Normalizing list of vectors to single batch");
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
        this.refreshBatchVisibility();
    }

    // Hides the batches BatchManager isn't rendering (see
    // utils/batchVisibility.js), so a scene with hundreds of envs doesn't pay
    // for hundreds of heightfield meshes every frame. Unlike Body's per-batch
    // objects these are still *built* up front -- the geometry is shared for a
    // singleton terrain, and a per-batch terrain needs its heightfield decoded
    // anyway for the terrain-query tooling.
    refreshBatchVisibility() {
        const batchManager = this.app.batchManager;
        if (!batchManager?.isBatchVisible || !this.group) return;
        for (let i = 0; i < batchManager.simBatches; i++) {
            const batchGroup = this.group.getObjectByName(`batch${i}`);
            if (batchGroup) batchGroup.visible = batchManager.isBatchVisible(i);
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

    // Delegates to utils.js so non-terrain consumers (Body.js's point-cloud
    // similarity recoloring) can resolve colormaps without a Terrain
    // instance. Kept as an instance method since Legend.js calls it via
    // `this.app.terrain.getCallableFromColorMapName(...)`.
    getCallableFromColorMapName(cmapName) {
        return resolveColorMap(cmapName);
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

    // Returns the per-batch data array for a diff layer name ("height", or
    // any named property).
    #diffLayerData(layer) {
        if (layer === "height") return this.heightData;
        return this.properties.get(layer);
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
            // picker used by height/named properties -- see Legend.js's
            // matching "diff" branch.
            callableColormap = this.getCallableFromColorMapName("coolwarm");
            diffLayer =
                this.app.uiState.terrainDiffLayer || this.getAvailableDiffLayers()[0];
            diffBatchA = this.app.uiState.terrainDiffBatchA ?? 0;
            diffBatchB =
                this.app.uiState.terrainDiffBatchB ??
                Math.min(1, this.app.batchManager.simBatches - 1);
            diffLayerData = this.#diffLayerData(diffLayer);
            maxAbsDelta = this.#maxAbsDelta(diffLayer, diffBatchA, diffBatchB);
        }

        // "features" mode: cosine similarity of every cell's own embedding
        // (this batch's data -- read below per-vertex, same convention named
        // properties use) to a single fixed query vector, from
        // wherever the user last clicked (any batch/cell). Also forces a
        // fixed diverging colormap, like "diff", since similarity is always
        // a signed [-1, 1] quantity.
        let featureQueryVec, featureQueryNorm;
        if (mode === "features") {
            callableColormap = this.getCallableFromColorMapName("coolwarm");
            const K = this.embeddingDim;
            const queryIndex = this.app.uiState.terrainFeatureQueryIndex;
            const queryBatch = this.app.uiState.terrainFeatureQueryBatch ?? 0;
            const queryDataBatchIndex = this.isSingleton ? 0 : queryBatch;
            const queryEmbData = this.embeddingData && this.embeddingData[queryDataBatchIndex];
            if (queryEmbData != null && queryIndex != null && K > 0) {
                const qBase = queryIndex * K;
                featureQueryVec = queryEmbData.slice(qBase, qBase + K);
                let qNorm = 0;
                for (let k = 0; k < K; k++) qNorm += featureQueryVec[k] * featureQueryVec[k];
                featureQueryNorm = Math.sqrt(qNorm);
            }
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

                const propData = this.properties.get(mode);
                if (propData && propData[batchIndex]) {
                    // Normalize against the data range shipped with the property
                    // (falls back to [0, 1]).
                    const propBounds = this.propertyBounds.get(mode) || {};
                    value = this.#normalizeToRange(
                        propData[batchIndex][dataIndex],
                        propBounds.min,
                        propBounds.max
                    );
                } else if (mode === "features") {
                    const K = this.embeddingDim;
                    const dataBatchIndex = this.isSingleton ? 0 : batchIndex;
                    const cellEmbData = this.embeddingData && this.embeddingData[dataBatchIndex];
                    if (featureQueryVec && cellEmbData && K > 0) {
                        const base = dataIndex * K;
                        let dot = 0;
                        let norm = 0;
                        for (let k = 0; k < K; k++) {
                            dot += cellEmbData[base + k] * featureQueryVec[k];
                            norm += cellEmbData[base + k] * cellEmbData[base + k];
                        }
                        norm = Math.sqrt(norm);
                        const cos =
                            norm > 0 && featureQueryNorm > 0
                                ? dot / (norm * featureQueryNorm)
                                : 0;
                        value = 0.5 + 0.5 * Math.max(-1, Math.min(1, cos));
                    } else {
                        value = 0.5; // no query yet (nothing clicked): render as the center color
                    }
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
        const layer = this.app.uiState.terrainDiffLayer || this.getAvailableDiffLayers()[0];
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
        for (const [name, data] of this.properties) {
            if (data && data.length > 0) modes.push(name);
        }
        if (this.app.batchManager.simBatches >= 2) {
            modes.push("diff");
        }
        if (this.embeddingData && this.embeddingData.length > 0) {
            modes.push("features");
        }
        return modes;
    }

    // Layer names ("height", or any named property) with per-batch data
    // present, for the diff mode's layer picker in Controls.js. "features"
    // isn't a scalar layer (it's a K-dim embedding) so it can't be a diff
    // target either, same reason "diff" itself is excluded.
    getAvailableDiffLayers() {
        return this.getAvailableColorModes().filter(
            (mode) => mode !== "diff" && mode !== "features"
        );
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

    // Reads height and every named property for `dataBatchIndex` at an
    // already-resolved flat grid index (see #resolveGridIndex). Shared by
    // getPropertiesAt and getPropertiesAtAllBatches so both look up data the
    // same way.
    #propsAtIndex(dataIndex, dataBatchIndex) {
        const props = {};
        if (this.heightData && this.heightData[dataBatchIndex]) {
            props.height = this.heightData[dataBatchIndex][dataIndex];
        } else {
            return null;
        }
        for (const [name, data] of this.properties) {
            if (data && data[dataBatchIndex]) {
                props[name] = data[dataBatchIndex][dataIndex];
            }
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

    // Sets the click-to-similarity query cell/batch and switches to
    // "features" color mode -- the terrain-click analog of
    // Body.recolorBySimilarity. `(x, y)` was clicked on `batchIndex`'s own
    // terrain patch, resolved to a grid cell the same way getPropertiesAt
    // does. Returns false (no query set) if the click missed the terrain extent.
    setFeatureQueryAt(x, y, batchIndex) {
        const dataIndex = this.#resolveGridIndex(x, y, batchIndex);
        if (dataIndex === null) return false;
        this.app.uiState.terrainFeatureQueryIndex = dataIndex;
        this.app.uiState.terrainFeatureQueryBatch = batchIndex;

        // Route through the lil-gui "colorMode" controller when one exists,
        // so its onChange (Controls.js::updateTerrainColorMode) handles the
        // mode switch + legend refresh + dropdown sync in one place, exactly
        // like applyViewState does for view-state restores (see
        // Controls.js::findController's docs -- setValue() both updates
        // uiState via onChange and refreshes the widget's display). Falls
        // back to updating the color mode directly when there's no UI
        // (tests, or any headless embedding of Terrain).
        const controller = this.app.uiControls?.findController?.("colorMode");
        if (controller) {
            controller.setValue("features");
        } else {
            this.app.uiState.terrainColorMode = "features";
            this.setColorMode("features");
        }
        return true;
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
