import * as THREE from "three";
import { BATCH_PALETTE_GENERATION_CONFIG } from "../config.js";
import { generateDivergingPalette } from "../objects/utils.js";
import {
    RENDER_ALL,
    RENDER_FOCUSED,
    defaultRenderMode,
    visibleBatchSet,
} from "../utils/batchVisibility.js";

export class BatchManager {
    constructor(app, modelData) {
        this.app = app;
        this.simBatches = 1; // Default to single batch
        this.currentlyActiveBatch = 0; // Default to the first batch
        // Which batches actually get built and drawn -- see
        // utils/batchVisibility.js. Set properly in _initialize once the batch
        // count is known.
        this.renderMode = RENDER_ALL;
        this.visibleBatches = new Set([0]);

        // Batch offset configuration
        this.spacing = 0.5; // Spacing between batches in meters
        this.batchOffsets = []; // Array of {x, y, z} offsets for each batch
        this.batchPalette = []; // Array of colors for each batch
        this.batchNames = []; // Array of display names for each batch
        this._initialize(modelData);
    }

    _initialize(modelData) {
        if (!modelData) return;

        // Set batch count from model data
        if (modelData.simBatches !== undefined) {
            this.simBatches = Math.max(1, parseInt(modelData.simBatches));
            console.log(
                `Initializing with ${this.simBatches} simulation batches`
            );
            this.app.simBatches = this.simBatches;
        }


        this.sideLength = Math.ceil(Math.sqrt(this.simBatches));
        const sideLength = this.sideLength;
        // Use README-defined terrain dimension names: sizeX, sizeY
        const { sizeX, sizeY } = modelData.terrain.dimensions;

        // Initialize batch offsets
        this.batchOffsets = [];
        for (let i = 0; i < this.simBatches; i++) {
            const rowIdx = Math.floor(i / sideLength);
            const colIdx = i % sideLength;
            this.batchOffsets.push({
                x: colIdx * (sizeX + this.spacing),
                y: rowIdx * (sizeY + this.spacing),
                z: 0,
            });
        }
        console.debug("Batch offsets initialized:", this.batchOffsets);

        this.renderMode = defaultRenderMode(this.simBatches);
        if (this.renderMode === RENDER_FOCUSED) {
            console.log(
                `${this.simBatches} batches: rendering only the focused one. ` +
                    "Toggle 'Render All Batches' in Controls to draw them all."
            );
        }
        this._recomputeVisibleBatches();

        this.batchPalette = generateDivergingPalette(
            BATCH_PALETTE_GENERATION_CONFIG.colors,
            this.simBatches + 1,
            BATCH_PALETTE_GENERATION_CONFIG.correctLightness
        );
        console.debug("Batch palette initialized:", this.batchPalette);

        const providedNames = Array.isArray(modelData.batchNames)
            ? modelData.batchNames
            : null;
        this.batchNames = Array.from({ length: this.simBatches }, (_, i) =>
            providedNames && typeof providedNames[i] === "string" && providedNames[i]
                ? providedNames[i]
                : `Batch ${i}`
        );
    }

    getBatchName(batchIndex) {
        return this.batchNames[batchIndex] ?? `Batch ${batchIndex}`;
    }

    setBatchName(batchIndex, name) {
        if (batchIndex < 0 || batchIndex >= this.simBatches) return;
        const trimmed = (name || "").trim() || `Batch ${batchIndex}`;
        this.batchNames[batchIndex] = trimmed;
        this._persistBatchNames();
        if (this.app.batchLegend) this.app.batchLegend.refresh();
        if (this.app.errorMetrics) this.app.errorMetrics.refreshBatchLabels();
        if (this.app.terrainProfile) this.app.terrainProfile.refreshBatchLabels();
    }

    async _persistBatchNames() {
        // Static demo mode: no backend available to persist batch names.
        // The rename still takes effect locally for the current session.
        if (this.app.staticBase) return;
        try {
            const response = await fetch("/batch-names", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ names: this.batchNames }),
            });
            if (!response.ok) {
                console.warn("Failed to persist batch names:", response.status);
            }
        } catch (e) {
            console.warn("Failed to persist batch names:", e);
        }
    }

    getSimBatches() {
        return this.simBatches;
    }

    getColorForBatch(batchIndex) {
        if (batchIndex < 0 || batchIndex >= this.simBatches) {
            return new THREE.Color(0x000000); // Default to black for invalid index
        }
        return this.batchPalette[batchIndex];
    }

    getRowColFromBatchIndex(batchIndex) {
        if (batchIndex < 0 || batchIndex >= this.simBatches) {
            return { row: -1, col: -1 };
        }
        const sideLength = this.sideLength;
        const rowIdx = Math.floor(batchIndex / sideLength);
        const colIdx = batchIndex % sideLength;
        return { row: rowIdx, col: colIdx };
    }

    getBatchIndexFromRowCol(rowIdx, colIdx) {
        const sideLength = this.sideLength;
        if (
            rowIdx < 0 ||
            colIdx < 0 ||
            rowIdx >= sideLength ||
            colIdx >= sideLength
        ) {
            return -1;
        }
        const batchIndex = rowIdx * sideLength + colIdx;
        if (batchIndex < 0 || batchIndex >= this.simBatches) {
            return -1;
        }
        return batchIndex;
    }

    getOffsetByRowCol(rowIdx, colIdx) {
        const sideLength = this.sideLength;
        if (
            rowIdx < 0 ||
            colIdx < 0 ||
            rowIdx >= sideLength ||
            colIdx >= sideLength
        ) {
            throw new Error("Invalid row or column index");
        }
        const batchIndex = rowIdx * sideLength + colIdx;
        return this.getBatchOffset(batchIndex);
    }

    // Get offset for a specific batch
    getBatchOffset(batchIndex) {
        if (batchIndex >= 0 && batchIndex < this.batchOffsets.length) {
            return this.batchOffsets[batchIndex];
        }
        return { x: 0, y: 0, z: 0 };
    }

    changeFocusOnBatchByRowCol(row, col) {
        const { camera, controls } = this.app.scene;
        const { x, y, z } = this.getOffsetByRowCol(row, col);
        const newCameraTarget = new THREE.Vector3(x, y, z);
        const oldCameraTarget = controls.target.clone();
        controls.target = newCameraTarget;
        camera.position.add(newCameraTarget.clone().sub(oldCameraTarget));
    }

    changeFocusOnBatchByIndex(batchIndex) {
        const { row, col } = this.getRowColFromBatchIndex(batchIndex);
        this.changeFocusOnBatchByRowCol(row, col);
    }

    setActiveBatch(batchIndex) {
        if (batchIndex < 0 || batchIndex >= this.simBatches) {
            // Bail out entirely: forwarding an index we just rejected left the
            // state window and plots focused on a batch that doesn't exist.
            console.warn("Invalid batch index:", batchIndex);
            return;
        }
        this.currentlyActiveBatch = batchIndex;
        this.changeFocusOnBatchByIndex(batchIndex);
        // In focused mode the newly-active batch is (probably) not the one
        // currently built/drawn, so refresh before the panels read from it.
        this._recomputeVisibleBatches();
        this.app.bodyStateWindow.setSelectedBatch(batchIndex);
        if (this.app.scalarPlotter) {
            this.app.scalarPlotter.setFocusedBatch(batchIndex);
        }
        if (this.app.batchLegend) {
            this.app.batchLegend.highlightActive();
        }
    }

    setActiveBatchByRowCol(row, col) {
        const batchIndex = this.getBatchIndexFromRowCol(row, col);
        if (batchIndex === -1) {
            return;
        }
        this.setActiveBatch(batchIndex);
    }

    // --- Which batches get rendered (see utils/batchVisibility.js) ---------

    isBatchVisible(batchIndex) {
        return this.visibleBatches.has(batchIndex);
    }

    setRenderMode(mode) {
        if (mode !== RENDER_ALL && mode !== RENDER_FOCUSED) return;
        if (this.renderMode === mode) return;
        this.renderMode = mode;
        this._recomputeVisibleBatches();
    }

    // Batches that must stay drawn even in focused mode, because a comparison
    // view is showing them next to the active one.
    _pinnedBatches() {
        const pinned = [];
        const uiState = this.app.uiState;
        if (uiState?.splitScreen) {
            pinned.push(uiState.splitBatchA, uiState.splitBatchB);
        }
        return pinned;
    }

    _recomputeVisibleBatches() {
        const previous = this.visibleBatches;
        this.visibleBatches = visibleBatchSet(
            this.renderMode,
            this.simBatches,
            this.currentlyActiveBatch,
            this._pinnedBatches()
        );
        if (
            previous &&
            previous.size === this.visibleBatches.size &&
            [...this.visibleBatches].every((i) => previous.has(i))
        ) {
            return; // unchanged; nothing to rebuild
        }
        this.applyBatchVisibility();
    }

    // Pushes the current visible set out to everything that owns per-batch
    // scene objects. Each of these builds a newly-visible batch's objects on
    // demand, so a batch never focused is never built at all.
    applyBatchVisibility() {
        this.app.bodies?.forEach((body) => body.refreshBatchVisibility?.());
        this.app.staticObjects?.forEach((so) => so.refreshBatchVisibility?.());
        this.app.terrain?.refreshBatchVisibility?.();
    }
}
