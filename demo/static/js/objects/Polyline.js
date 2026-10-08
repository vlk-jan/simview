import * as THREE from "three";
import { toFlatFloat32Array } from "./utils.js";

// A world-space polyline (see json-format.md `model.polylines`): either a
// fixed `points` list, or a per-frame `frames` blob of shape
// (T, B, maxVertices, 3) whose trailing NaN rows pad each frame. One
// THREE.Line per batch at the batch offset; the static form shares one
// geometry across batches, the per-frame form owns one per batch.
//
// `width` is forwarded to the material but WebGL draws every line 1 px wide
// (Line2 from three's addons would honour it; not vendored).
export class Polyline {
    constructor(data, app) {
        this.app = app;
        this.name = data.name;
        this.batchSize = app.batchManager.simBatches;
        this.visibleRanges = data.visibleRanges ?? null;
        this.userVisible = app.uiState.polylinesVisible !== false;
        this.dashed = !!data.dashed;
        this.maxVertices = data.frames ? data.maxVertices : 0;
        this.frames = data.frames ? toFlatFloat32Array(data.frames) : null;
        this.group = new THREE.Group();
        this.group.name = this.name;
        this.group.visible = this.userVisible;
        this.lines = [];

        const color = new THREE.Color(...(data.color || [1, 1, 1]));
        const opts = { color, linewidth: data.width || 1 };
        this.material = this.dashed
            ? new THREE.LineDashedMaterial({ ...opts, dashSize: 0.5, gapSize: 0.25 })
            : new THREE.LineBasicMaterial(opts);

        const staticGeometry = data.points ? this.#geometry(toFlatFloat32Array(data.points)) : null;
        for (let i = 0; i < this.batchSize; i++) {
            const geometry = this.frames
                ? this.#geometry(new Float32Array(this.maxVertices * 3))
                : staticGeometry;
            const line = new THREE.Line(geometry, this.material);
            // A NaN padding tail would poison the bounding sphere and get the
            // whole line culled, so skip frustum culling.
            line.frustumCulled = false;
            const offset = app.batchManager.getBatchOffset(i);
            line.position.set(offset.x, offset.y, offset.z);
            if (!this.frames && this.dashed) line.computeLineDistances();
            this.group.add(line);
            this.lines.push(line);
        }
        this.refreshBatchVisibility();
    }

    #geometry(flat) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(flat, 3));
        return geometry;
    }

    // Per-frame form: copy frame `index`'s vertices into each batch's
    // geometry and draw up to the first NaN row.
    update(index) {
        if (!this.frames) return;
        const stride = this.maxVertices * 3;
        for (let b = 0; b < this.batchSize; b++) {
            const line = this.lines[b];
            const position = line.geometry.attributes.position;
            const base = (index * this.batchSize + b) * stride;
            const array = position.array;
            array.set(this.frames.subarray(base, base + stride));
            let count = 0;
            while (count < this.maxVertices && Number.isFinite(array[count * 3])) count++;
            // Overwrite the NaN padding with the last vertex: the draw range
            // hides it anyway, and three.js computes a bounding sphere over the
            // whole buffer (a NaN radius logs an error every frame).
            const last = Math.max(count - 1, 0) * 3;
            for (let v = count; v < this.maxVertices; v++) {
                array[v * 3] = count ? array[last] : 0;
                array[v * 3 + 1] = count ? array[last + 1] : 0;
                array[v * 3 + 2] = count ? array[last + 2] : 0;
            }
            line.geometry.setDrawRange(0, count);
            position.needsUpdate = true;
            if (this.dashed) line.computeLineDistances();
        }
    }

    refreshBatchVisibility() {
        const batchManager = this.app.batchManager;
        if (!batchManager?.isBatchVisible) return;
        this.lines.forEach((line, i) => (line.visible = batchManager.isBatchVisible(i)));
    }

    setVisible(flag) {
        this.userVisible = flag;
        this.group.visible = flag;
    }

    setTimeVisible(flag) {
        this.group.visible = flag && this.userVisible;
    }

    getObject3D() {
        return this.group;
    }

    dispose() {
        this.app.scene?.removeObject3D?.(this.group);
        new Set(this.lines.map((l) => l.geometry)).forEach((g) => g.dispose());
        this.material.dispose();
        this.lines = [];
    }
}
