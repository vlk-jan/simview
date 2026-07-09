import * as THREE from "three";
import { BODY_CONFIG, BODY_VECTOR_CONFIG, TRAIL_CONFIG } from "../config.js";
import {
    createGeometry,
    createMesh,
    createPoints,
    createContactPoints,
    createArrow,
} from "./utils.js";

export class Body {
    constructor(bodyData, app) {
        this.app = app;
        this.name = bodyData.name;
        this.simBatches = app.batchManager.simBatches;

        // Data Normalization: Handle numeric shape types
        if (bodyData.shape && typeof bodyData.shape.type === "number") {
            const typeMap = { 0: "custom", 1: "box", 2: "sphere", 3: "cylinder" };
            if (typeMap[bodyData.shape.type]) {
                console.debug(`Normalizing shape type ${bodyData.shape.type} to ${typeMap[bodyData.shape.type]}`);
                bodyData.shape.type = typeMap[bodyData.shape.type];
            } else {
                console.warn(`Unknown numeric shape type: ${bodyData.shape.type}`);
            }
        } else {
            console.debug(`Shape type is: ${bodyData.shape ? bodyData.shape.type : 'undefined'}`);
        }

        // Data Normalization: Handle root-level bodyPoints
        if (bodyData.bodyPoints && !bodyData.shape.points) {
            bodyData.shape.points = bodyData.bodyPoints;
        }

        // Mandatory attributes
        this.positions = Array(this.simBatches)
            .fill()
            .map(() => new THREE.Vector3());
        this.quaternions = Array(this.simBatches)
            .fill()
            .map(() => new THREE.Quaternion());
        this.rotations = Array(this.simBatches)
            .fill()
            .map(() => new THREE.Euler()); // For debugging/display

        // Initialize pose from bodyTransform if available
        if (bodyData.bodyTransform) {
            const transforms = Array.isArray(bodyData.bodyTransform[0]) ? bodyData.bodyTransform : [bodyData.bodyTransform];
            for (let i = 0; i < Math.min(this.simBatches, transforms.length); i++) {
                const t = transforms[i];
                if (t.length >= 7) {
                    this.positions[i].set(t[0], t[1], t[2]);
                    // JSON quaternion order in bodyTransform is [w, x, y, z] based on observation
                    // Three.js set() takes (x, y, z, w)
                    this.quaternions[i].set(t[4], t[5], t[6], t[3]);
                    this.rotations[i].setFromQuaternion(this.quaternions[i]);
                }
            }
        }

        // Optional attributes management: only what the JSON actually declares as
        // available is exposed to the UI, so options for missing data stay hidden.
        this.availableAttributes = new Set();
        if (bodyData.availableAttributes) {
            bodyData.availableAttributes.forEach(attr => this.availableAttributes.add(attr));
        }

        // Storage/updaters are always set up so state updates can be applied if
        // data arrives, independent of whether the attribute is UI-visible.
        this.attributeStorage = new Map();
        this.attributeUpdaters = new Map();

        const vectorAttrs = ["velocity", "angularVelocity", "force", "torque"];
        vectorAttrs.forEach(attr => {
            this.attributeStorage.set(attr, Array(this.simBatches).fill().map(() => new THREE.Vector3()));
            this.attributeUpdaters.set(attr, (data, batchIndex) => this.updateBodyVector(attr, data, batchIndex));
        });

        this.attributeStorage.set("contacts", Array(this.simBatches).fill().map(() => []));
        this.attributeUpdaters.set("contacts", (data, batchIndex) => this.updateContactPointsVisibility(data, batchIndex));

        this.hasContacts = this.availableAttributes.has("contacts");

        // Reusable temporaries for hot-path matrix updates (avoid per-frame allocations)
        this._worldPos = new THREE.Vector3();
        this._unitScale = new THREE.Vector3(1, 1, 1);
        this._matrix = new THREE.Matrix4();
        this._normalizedVec = new THREE.Vector3();

        // Scene setup
        this.group = new THREE.Group();
        this.group.name = this.name;
        this.batchGroups = [];
        this.bodyVectors = [];
        this.contactPoints = [];
        this.contactPointSizes = [];
        this.representations = { mesh: [], wireframe: [], points: [] };
        this.createBatchGroups(bodyData);

        // Position/orientation history across all loaded states, per batch. Local
        // (un-offset) coordinates, shared by trail rendering and error metrics.
        this.numStates = 0;
        this.positionHistory = [];
        this.quaternionHistory = [];
        this.trails = [];
        this._trailStateIndex = -1;
    }

    // --- History (position/orientation over all states) ---

    allocateHistory(numStates) {
        this.allocatedStates = numStates;
        this.validStates = numStates;
        this.positionHistory = Array(this.simBatches)
            .fill()
            .map(() => new Float32Array(numStates * 3));
        this.quaternionHistory = Array(this.simBatches)
            .fill()
            .map(() => new Float32Array(numStates * 4));
    }

    setHistoryPointAt(stateIndex, bodyState) {
        if (!bodyState.bodyTransform) return;
        const transformData = bodyState.bodyTransform;
        const transforms = Array.isArray(transformData[0])
            ? transformData
            : [transformData];
        for (let i = 0; i < Math.min(this.simBatches, transforms.length); i++) {
            const t = transforms[i];
            if (t.length < 7) continue;
            const pBase = stateIndex * 3;
            this.positionHistory[i][pBase] = t[0];
            this.positionHistory[i][pBase + 1] = t[1];
            this.positionHistory[i][pBase + 2] = t[2];
            const qBase = stateIndex * 4;
            // Stored as (x, y, z, w) to match THREE.Quaternion's convention.
            this.quaternionHistory[i][qBase] = t[4];
            this.quaternionHistory[i][qBase + 1] = t[5];
            this.quaternionHistory[i][qBase + 2] = t[6];
            this.quaternionHistory[i][qBase + 3] = t[3];
        }
    }

    appendHistoryPointAt(stateIndex, bodyState) {
        if (!this.positionHistory || this.positionHistory.length === 0) {
            this.allocateHistory(100);
            this.validStates = 0;
        }
        if (stateIndex >= this.allocatedStates) {
            const newNumStates = Math.max(stateIndex + 1, this.allocatedStates * 2 || 100);
            for(let i=0; i<this.simBatches; i++) {
                const newPos = new Float32Array(newNumStates * 3);
                newPos.set(this.positionHistory[i]);
                this.positionHistory[i] = newPos;
                const newQuat = new Float32Array(newNumStates * 4);
                newQuat.set(this.quaternionHistory[i]);
                this.quaternionHistory[i] = newQuat;
            }
            this.allocatedStates = newNumStates;
        }
        this.setHistoryPointAt(stateIndex, bodyState);
        this.validStates = Math.max(this.validStates || 0, stateIndex + 1);
    }

    // --- Trails ---

    finalizeTrails() {
        this.disposeTrails();
        const count = this.validStates || 0;
        if (count < 2) return;
        for (let i = 0; i < this.simBatches; i++) {
            const offset = this.app.batchManager
                ? this.app.batchManager.getBatchOffset(i)
                : { x: 0, y: 0, z: 0 };
            const localPositions = this.positionHistory[i];
            const worldPositions = new Float32Array(count * 3);
            for (let s = 0; s < count; s++) {
                const base = s * 3;
                worldPositions[base] = localPositions[base] + offset.x;
                worldPositions[base + 1] = localPositions[base + 1] + offset.y;
                worldPositions[base + 2] = localPositions[base + 2] + offset.z;
            }
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
                "position",
                new THREE.BufferAttribute(worldPositions, 3)
            );
            geometry.setDrawRange(0, 1);
            const color = this.app.batchManager
                ? this.app.batchManager.getColorForBatch(i)
                : 0xffffff;
            const material = new THREE.LineBasicMaterial({
                color,
                transparent: true,
                opacity: TRAIL_CONFIG.opacity,
            });
            const line = new THREE.Line(geometry, material);
            line.frustumCulled = false;
            line.visible = this.app.uiState.trailsVisible || false;
            this.group.add(line);
            this.trails[i] = line;
        }
        this._trailStateIndex = -1;
        const currentIndex = this.app.animationController
            ? this.app.animationController.getCurrentStateIndex()
            : 0;
        this.updateTrails(currentIndex);
    }

    updateTrails(stateIndex) {
        if (this._trailStateIndex === stateIndex || this.trails.length === 0) return;
        this._trailStateIndex = stateIndex;
        const count = Math.max(1, Math.min(stateIndex + 1, this.validStates || 1));
        for (const line of this.trails) {
            if (line) line.geometry.setDrawRange(0, count);
        }
    }

    toggleTrails(visible) {
        this.trails.forEach((line) => line && (line.visible = visible));
    }

    disposeTrails() {
        for (const line of this.trails) {
            if (line) {
                this.group.remove(line);
                line.geometry.dispose();
                line.material.dispose();
            }
        }
        this.trails = [];
    }

    createBatchGroups(bodyData) {
        const shape = bodyData.shape;

        // Initialize instanced representations
        if (shape.points && shape.points.length > 0) {
            this.representations["points"] = this.createInstancedRepresentation(
                "points",
                shape.points,
                BODY_CONFIG.points,
                bodyData
            );
        }

        if (shape.type !== "pointcloud") {
            const geometry = createGeometry(shape, BODY_CONFIG.geometry);
            if (geometry) {
                this.representations["mesh"] = this.createInstancedRepresentation(
                    "mesh",
                    geometry,
                    BODY_CONFIG.mesh,
                    bodyData
                );
                this.representations["wireframe"] = this.createInstancedRepresentation(
                    "wireframe",
                    geometry,
                    BODY_CONFIG.wireframe,
                    bodyData
                );
            }
        }

        // Initialize contact points
        if (
            this.hasContacts &&
            (shape.type === "pointcloud" || shape.type === "mesh" || shape.points || shape.vertices)
        ) {
            const points = shape.points || shape.vertices;
            this.initializeInstancedContactPoints(points);
        }

        // We still need batch groups for individual axes or other non-instanced elements
        for (let i = 0; i < this.simBatches; i++) {
            const batchGroup = new THREE.Group();
            batchGroup.name = `${this.name}_batch_${i}`;
            this.group.add(batchGroup);
            this.batchGroups.push(batchGroup);

            // Axes helper is not instanced for now as it's for debugging
            const axes = new THREE.AxesHelper(1);
            axes.visible = this.app.uiState.axesVisible;
            batchGroup.add(axes);

            // Body vectors (arrows) are also not instanced yet
            this.initializeBodyVectors(batchGroup, BODY_VECTOR_CONFIG, i);
        }

        // Initial update of instances
        this.updateAllInstances();
    }

    createInstancedRepresentation(type, source, config, bodyData) {
        if (type === "points") {
            const pointsList = [];
            for (let i = 0; i < this.simBatches; i++) {
                const points = createPoints(source, config);
                if (points) {
                    points.visible = this.app.uiState.bodyVisualizationMode === "points";
                    this.group.add(points);
                    pointsList.push(points);
                }
            }
            return pointsList;
        } else {
            let material;
            if (type === "mesh") {
                material = createMesh(source, config).material;
            } else if (type === "wireframe") {
                // InstancedMesh only works with Mesh primitives, so we use a Mesh material with wireframe: true
                material = new THREE.MeshBasicMaterial({
                    color: config.color || 0x4080ff,
                    wireframe: true,
                    transparent: config.transparent || false,
                    opacity: config.opacity || 1.0
                });
            }

            const instancedMesh = new THREE.InstancedMesh(source, material, this.simBatches);
            instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            instancedMesh.visible = this.app.uiState.bodyVisualizationMode === type;
            instancedMesh.castShadow = (type === "mesh");
            instancedMesh.receiveShadow = (type === "mesh");
            this.group.add(instancedMesh);
            return instancedMesh;
        }
    }

    initializeInstancedContactPoints(points) {
        if (!points?.length) return;
        for (let i = 0; i < this.simBatches; i++) {
            const contactPoints = createContactPoints(points, BODY_CONFIG.contactPoints);
            if (contactPoints) {
                const pointCount = points.length;
                this.contactPointSizes[i] = new Float32Array(pointCount).fill(0);
                contactPoints.geometry.setAttribute(
                    "size",
                    new THREE.Float32BufferAttribute(this.contactPointSizes[i], 1)
                );
                contactPoints.visible = this.app.uiState.attributeVisible.contacts || false;
                this.group.add(contactPoints);
                this.contactPoints[i] = contactPoints;
            }
        }
    }

    updateAllInstances() {
        for (let i = 0; i < this.simBatches; i++) {
            this.updateInstanceMatrix(i);
        }
        // Set needsUpdate only once after all matrices are updated
        if (this.representations["mesh"] instanceof THREE.InstancedMesh) {
            this.representations["mesh"].instanceMatrix.needsUpdate = true;
        }
        if (this.representations["wireframe"] instanceof THREE.InstancedMesh) {
            this.representations["wireframe"].instanceMatrix.needsUpdate = true;
        }
    }

    updateInstanceMatrix(batchIndex) {
        if (batchIndex >= this.simBatches) return;

        const position = this.positions[batchIndex];
        const quaternion = this.quaternions[batchIndex];

        if (!position || !quaternion) {
            console.warn(`Position or quaternion missing for batch ${batchIndex}`);
            return;
        }

        const offset = this.app.batchManager
            ? this.app.batchManager.getBatchOffset(batchIndex)
            : { x: 0, y: 0, z: 0 };

        this._worldPos.set(
            position.x + offset.x,
            position.y + offset.y,
            position.z + offset.z
        );

        this._matrix.compose(this._worldPos, quaternion, this._unitScale);

        // Update InstancedMesh instances without setting needsUpdate yet
        if (this.representations["mesh"] instanceof THREE.InstancedMesh) {
            this.representations["mesh"].setMatrixAt(batchIndex, this._matrix);
        }
        if (this.representations["wireframe"] instanceof THREE.InstancedMesh) {
            this.representations["wireframe"].setMatrixAt(batchIndex, this._matrix);
        }

        // Update non-instanced representations with strict index checks
        const pointsRep = this.representations["points"];
        if (Array.isArray(pointsRep) && pointsRep[batchIndex]) {
            pointsRep[batchIndex].position.copy(this._worldPos);
            pointsRep[batchIndex].quaternion.copy(quaternion);
        }

        if (Array.isArray(this.contactPoints) && this.contactPoints[batchIndex]) {
            this.contactPoints[batchIndex].position.copy(this._worldPos);
            this.contactPoints[batchIndex].quaternion.copy(quaternion);
        }

        if (Array.isArray(this.batchGroups) && this.batchGroups[batchIndex]) {
            this.batchGroups[batchIndex].position.copy(this._worldPos);
            this.batchGroups[batchIndex].quaternion.copy(quaternion);
        }
    }

    updateAttribute(attr, data, batchIndex) {
        if (!this.attributeStorage.has(attr) || batchIndex >= this.simBatches)
            return;
        const storage = this.attributeStorage.get(attr);
        if (attr === "contacts") {
            storage[batchIndex] = Array.isArray(data) ? data : [];
        } else {
            storage[batchIndex].fromArray(data.length >= 3 ? data : [0, 0, 0]);
        }
        const updater = this.attributeUpdaters.get(attr);
        if (updater) updater(storage[batchIndex], batchIndex);
    }

    updateState(bodyState) {
        // Update from bodyTransform (combined position + orientation [w,x,y,z])
        if (bodyState.bodyTransform) {
            const transformData = bodyState.bodyTransform;
            const applyTransform = (t, i) => {
                if (t.length >= 7) {
                    this.positions[i].set(t[0], t[1], t[2]);
                    // Three.js set() takes (x, y, z, w)
                    this.quaternions[i].set(t[4], t[5], t[6], t[3]);
                    this.rotations[i].setFromQuaternion(this.quaternions[i]);
                }
            };
            if (Array.isArray(transformData[0])) {
                for (let i = 0; i < Math.min(this.simBatches, transformData.length); i++) {
                    applyTransform(transformData[i], i);
                }
            } else {
                applyTransform(transformData, 0);
            }
        }

        // Update vector attributes (velocity, angularVelocity, force, torque). Each
        // is provided directly under its own key, batched or single like bodyTransform.
        const vectorAttrs = ["velocity", "angularVelocity", "force", "torque"];
        vectorAttrs.forEach((attr) => {
            const data = bodyState[attr];
            if (!data) return;
            if (Array.isArray(data[0])) {
                for (let i = 0; i < Math.min(this.simBatches, data.length); i++) {
                    this.updateAttribute(attr, data[i], i);
                }
            } else {
                this.updateAttribute(attr, data, 0);
            }
        });

        if (bodyState.contacts) {
            const contactsData = bodyState.contacts;
            if (Array.isArray(contactsData)) {
                for (let i = 0; i < Math.min(this.simBatches, contactsData.length); i++) {
                    this.updateAttribute("contacts", contactsData[i], i);
                }
            }
        }

        // Finally update all instance matrices in one go
        this.updateAllInstances();

        if (this.trails.length > 0 && this.app.animationController) {
            this.updateTrails(this.app.animationController.getCurrentStateIndex());
        }
    }

    setPosition(positionData, batchIndex = 0) {
        if (
            !positionData ||
            positionData.length < 3 ||
            batchIndex >= this.simBatches
        )
            return;
        const [x, y, z] = positionData;
        this.positions[batchIndex].set(x, y, z);
        this.updateInstanceMatrix(batchIndex);
    }

    setOrientation(orientationData, batchIndex = 0) {
        if (
            !orientationData ||
            orientationData.length < 4 ||
            batchIndex >= this.simBatches
        )
            return;
        const [qw, qx, qy, qz] = orientationData;
        this.quaternions[batchIndex].set(qx, qy, qz, qw);
        this.rotations[batchIndex].setFromQuaternion(this.quaternions[batchIndex]);
        this.updateInstanceMatrix(batchIndex);
    }

    initializeBodyVectors(batchGroup, vectorConfigs, batchIndex) {
        if (!this.bodyVectors[batchIndex]) {
            this.bodyVectors[batchIndex] = new Map();
        }
        for (const attr of this.availableAttributes) {
            if (attr !== "contacts" && vectorConfigs[attr]) {
                const config = vectorConfigs[attr];
                const vector = createArrow(
                    new THREE.Vector3(),
                    new THREE.Vector3(0, 1, 0),
                    config
                );
                vector.visible = this.app.uiState.attributeVisible[attr] || false;
                vector.userData = { scale: config.scale };
                batchGroup.add(vector);
                this.bodyVectors[batchIndex].set(attr, vector);
            }
        }
    }

    updateBodyVector(type, vector, batchIndex) {
        const arrow = this.bodyVectors[batchIndex]?.get(type);
        if (!arrow) return;
        const scale = arrow.userData.scale || 1.0;
        const length = vector.length() * scale;
        if (length < 1e-6) {
            arrow.setLength(0);
            return;
        }
        this._normalizedVec.copy(vector).normalize();
        arrow.setDirection(this._normalizedVec);
        const headLength = Math.min(length * 0.2, 0.5);
        const headWidth = Math.min(length * 0.1, 0.25);
        arrow.setLength(length, headLength, headWidth);
    }

    updateContactPointsVisibility(contactIndices, batchIndex) {
        if (!this.contactPoints[batchIndex] || !this.contactPointSizes[batchIndex])
            return;
        this.contactPointSizes[batchIndex].fill(0);
        if (Array.isArray(contactIndices)) {
            contactIndices.forEach((index) => {
                if (index >= 0 && index < this.contactPointSizes[batchIndex].length) {
                    this.contactPointSizes[batchIndex][index] =
                        BODY_CONFIG.contactPoints.size;
                }
            });
        }
        const sizeAttribute =
            this.contactPoints[batchIndex].geometry.getAttribute("size");
        sizeAttribute.array = this.contactPointSizes[batchIndex];
        sizeAttribute.needsUpdate = true;
    }

    updateVisualizationMode(mode) {
        for (const [type, obj] of Object.entries(this.representations)) {
            if (obj instanceof THREE.InstancedMesh) {
                obj.visible = type === mode;
            } else if (Array.isArray(obj)) {
                obj.forEach((o) => (o.visible = type === mode));
            }
        }
    }

    toggleContactPoints(visible) {
        this.contactPoints.forEach((cp) => cp && (cp.visible = visible));
    }

    toggleAxes(visible) {
        this.batchGroups.forEach((group) => {
            const axes = group.children.find(
                (child) => child instanceof THREE.AxesHelper
            );
            if (axes) axes.visible = visible;
        });
    }

    toggleBodyVector(type, visible) {
        if (!this.availableAttributes.has(type)) return;
        this.bodyVectors.forEach((map) => {
            const vector = map.get(type);
            if (vector) vector.visible = visible;
        });
    }

    getObject3D() {
        return this.group;
    }

    getAvailableAttributes() {
        return this.availableAttributes;
    }

    // Which of the mesh/wireframe/points representations this body actually has,
    // so the UI can only offer visualization modes that will show something.
    getAvailableVisualizationModes() {
        const modes = [];
        for (const type of ["mesh", "wireframe", "points"]) {
            const rep = this.representations[type];
            if (
                rep instanceof THREE.InstancedMesh ||
                (Array.isArray(rep) && rep.length > 0)
            ) {
                modes.push(type);
            }
        }
        return modes;
    }

    dispose() {
        if (this.group && this.group.parent) {
            this.group.parent.remove(this.group);
            this.group.traverse((child) => {
                if (child.geometry) child.geometry.dispose();
                if (child.material) {
                    Array.isArray(child.material)
                        ? child.material.forEach((m) => m.dispose())
                        : child.material.dispose();
                }
            });
        }
        this.group = null;
        this.batchGroups = [];
        this.bodyVectors = [];
        this.contactPoints = [];
        this.contactPointSizes = [];
        this.trails = [];
    }
}
