import * as THREE from "three";
import { STATIC_OBJECT_CONFIG } from "../config.js"; // Assuming this exists
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
        const geometryConfig = STATIC_OBJECT_CONFIG.geometry || {};

        if (this.isSingleton) {
            const shape = objectData.shape;
            const meshConfig = {
                ...STATIC_OBJECT_CONFIG.mesh,
                color: shape.color || STATIC_OBJECT_CONFIG.color || 0xffffff,
            };
            const pointsConfig = {
                ...STATIC_OBJECT_CONFIG.points,
                color: shape.color || STATIC_OBJECT_CONFIG.color || 0xffffff,
            };

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
                    color: STATIC_OBJECT_CONFIG.wireframe?.color || 0x4080ff,
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
                const meshConfig = {
                    ...STATIC_OBJECT_CONFIG.mesh,
                    color: shape.color || STATIC_OBJECT_CONFIG.color || 0xffffff,
                };
                const pointsConfig = {
                    ...STATIC_OBJECT_CONFIG.points,
                    color: shape.color || STATIC_OBJECT_CONFIG.color || 0xffffff,
                };

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

    /** Update visualization mode (mesh, wireframe, points) */
    updateVisualizationMode(mode) {
        for (const [type, obj] of Object.entries(this.representations)) {
            if (obj instanceof THREE.InstancedMesh) {
                obj.visible = type === mode;
            } else if (Array.isArray(obj)) {
                obj.forEach((o) => (o.visible = type === mode));
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

            this.group = null;
            this.representations = { mesh: [], wireframe: [], points: [] };
            this.batchGroups = [];
        }
    }
}
