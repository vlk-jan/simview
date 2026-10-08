import * as THREE from "three";
import { STATIC_OBJECT_CONFIG } from "../config.js";
import {
    createGeometry,
    createMesh,
    createPoints,
    createWireframe,
} from "./utils.js";

export class StaticObject {
    constructor(objectData, app) {
        this.app = app;
        this.name = objectData.name;
        this.isSingleton = objectData.isSingleton || false; // Default to false if not specified
        this.batchSize = app.batchManager.simBatches;
        this.representations = { mesh: [], wireframe: [], points: [] }; // For visualization modes
        this.batchGroups = []; // Store batch groups

        // Validate input data
        if (this.isSingleton) {
            if (!objectData.shape || !objectData.shape.type) {
                throw new Error(
                    "Singleton static object requires a 'shape' definition."
                );
            }
            this.type = objectData.shape.type;
        } else {
            if (
                !Array.isArray(objectData.shapes) ||
                objectData.shapes.length !== this.batchSize
            ) {
                throw new Error(
                    `Batched static object requires a 'shapes' array of length ${this.batchSize}.`
                );
            }
            this.type = objectData.shapes[0].type; // Assume consistent types for simplicity
        }

        // Initialize and create visual objects
        this.initializeGroup();
        this.createBatchGroups(objectData);
    }

    /** Initialize the main Three.js group */
    initializeGroup() {
        this.group = new THREE.Group();
        this.group.name = this.name;
    }

    createBatchGroups(objectData) {
        const geometryConfig = STATIC_OBJECT_CONFIG.geometry;
        const configsFor = (shape) => {
            const color = shape.color || 0xffffff;
            return [{ color }, { ...STATIC_OBJECT_CONFIG.points, color }];
        };

        if (this.isSingleton) {
            const shape = objectData.shape;
            const [meshConfig, pointsConfig] = configsFor(shape);

            if (shape.type === "pointcloud") {
                for (let i = 0; i < this.batchSize; i++) {
                    const points = createPoints(shape.points, pointsConfig);
                    if (points) {
                        points.visible = this.app.uiState.bodyVisualizationMode === "points";
                        const offset = this.app.batchManager.getBatchOffset(i);
                        points.position.set(offset.x, offset.y, offset.z);
                        this.group.add(points);
                        this.representations["points"].push(points);
                    }
                }
            } else {
                const geometry = createGeometry(shape, geometryConfig);
                const meshMaterial = createMesh(geometry, meshConfig).material;
                const wireframeMaterial = new THREE.MeshBasicMaterial({
                    color: STATIC_OBJECT_CONFIG.wireframe.color,
                    wireframe: true,
                    transparent: true,
                    opacity: 0.2
                });

                const instancedMesh = new THREE.InstancedMesh(geometry, meshMaterial, this.batchSize);
                const instancedWireframe = new THREE.InstancedMesh(geometry, wireframeMaterial, this.batchSize);

                for (let i = 0; i < this.batchSize; i++) {
                    const offset = this.app.batchManager.getBatchOffset(i);
                    const matrix = new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z);
                    instancedMesh.setMatrixAt(i, matrix);
                    instancedWireframe.setMatrixAt(i, matrix);
                }

                instancedMesh.visible = this.app.uiState.bodyVisualizationMode === "mesh";
                instancedWireframe.visible = this.app.uiState.bodyVisualizationMode === "wireframe";

                this.group.add(instancedMesh);
                this.group.add(instancedWireframe);

                this.representations["mesh"] = instancedMesh;
                this.representations["wireframe"] = instancedWireframe;
            }
        } else {
            // Non-singleton: reuse geometry if possible (if all shapes are same type and same dimensions)
            // For now, keep as is but optimize material/geometry creation if they are identical
            for (let i = 0; i < this.batchSize; i++) {
                const batchGroup = new THREE.Group();
                batchGroup.name = `${this.name}_batch_${i}`;
                this.group.add(batchGroup);
                this.batchGroups.push(batchGroup);

                const shape = objectData.shapes[i];
                const [meshConfig, pointsConfig] = configsFor(shape);

                if (shape.type === "pointcloud") {
                    const points = createPoints(shape.points, pointsConfig);
                    if (points) {
                        points.visible = this.app.uiState.bodyVisualizationMode === "points";
                        batchGroup.add(points);
                        this.representations["points"].push(points);
                    }
                } else {
                    const geometry = createGeometry(shape, geometryConfig);
                    const mesh = createMesh(geometry, meshConfig);
                    mesh.visible = this.app.uiState.bodyVisualizationMode === "mesh";
                    batchGroup.add(mesh);
                    this.representations["mesh"].push(mesh);
                    const wireframe = createWireframe(geometry, STATIC_OBJECT_CONFIG.wireframe);
                    wireframe.visible = this.app.uiState.bodyVisualizationMode === "wireframe";
                    batchGroup.add(wireframe);
                    this.representations["wireframe"].push(wireframe);
                }

                const offset = this.app.batchManager.getBatchOffset(i);
                batchGroup.position.set(offset.x, offset.y, offset.z);
            }
        }
    }

    // Hides the batches BatchManager isn't rendering (see
    // utils/batchVisibility.js). Only meaningful for non-singleton static
    // objects, which get one group per batch; the singleton path is a single
    // instanced draw covering all of them.
    refreshBatchVisibility() {
        const batchManager = this.app.batchManager;
        if (!batchManager?.isBatchVisible) return;
        this.batchGroups.forEach((batchGroup, i) => {
            if (batchGroup) batchGroup.visible = batchManager.isBatchVisible(i);
        });
        // Singleton point clouds are one object per batch rather than a group.
        const points = this.representations["points"];
        if (this.isSingleton && Array.isArray(points)) {
            points.forEach((object, i) => {
                if (!object) return;
                object.visible =
                    batchManager.isBatchVisible(i) &&
                    this.app.uiState.bodyVisualizationMode === "points";
            });
        }
    }

    /** Update visualization mode (mesh, wireframe, points) */
    updateVisualizationMode(mode) {
        // A singleton point cloud is one object per batch outside any batch
        // group, so a hidden batch has to be respected here (non-singleton
        // objects sit in per-batch groups, which carry it).
        const batchVisible = (i) => !this.isSingleton || this.app.batchManager.isBatchVisible(i);
        for (const [type, obj] of Object.entries(this.representations)) {
            if (obj instanceof THREE.InstancedMesh) {
                obj.visible = type === mode;
            } else if (Array.isArray(obj)) {
                obj.forEach((o, i) => (o.visible = type === mode && batchVisible(i)));
            }
        }
    }

    /** Return the Three.js group for scene integration */
    getObject3D() {
        return this.group;
    }

    /** Clean up resources */
    dispose() {
        if (this.group) {
            if (
                this.app.scene &&
                typeof this.app.scene.removeObject3D === "function"
            ) {
                this.app.scene.removeObject3D(this.group);
            } else if (this.group.parent) {
                this.group.parent.remove(this.group);
            }
            // Geometry/materials are shared between the mesh and wireframe
            // of a batch, so dedupe before disposing.
            const geometries = new Set();
            const materials = new Set();
            this.group.traverse((child) => {
                if (child.geometry) geometries.add(child.geometry);
                if (child.material) {
                    (Array.isArray(child.material) ? child.material : [child.material]).forEach(
                        (m) => materials.add(m)
                    );
                }
            });
            geometries.forEach((g) => g.dispose());
            materials.forEach((m) => m.dispose());

            this.group = null;
            this.representations = { mesh: [], wireframe: [], points: [] };
            this.batchGroups = [];
        }
    }
}
