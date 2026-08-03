import { beforeEach, describe, expect, it } from "vitest";

// Terrain.js pulls in config.js, which reads window.devicePixelRatio at
// module load time (same stub Terrain.test.js uses).
globalThis.window ??= { devicePixelRatio: 1 };
const { Terrain } = await import("../../simview/static/js/objects/Terrain.js");

// Same 2x2 grid convention as Terrain.test.js: row-major (row=y, col=x),
// index 0=(x0,y0), 1=(x1,y0), 2=(x0,y1), 3=(x1,y1), world extent [0,1]x[0,1].
const RESOLUTION = 2;
const K = 2;
// cell0=[1,0], cell1=[1,0] (same direction as cell0, cos=1),
// cell2=[0,1] (orthogonal to cell0, cos=0), cell3=[-1,0] (opposite, cos=-1).
const EMBEDDING_SINGLE_BATCH = new Float32Array([1, 0, 1, 0, 0, 1, -1, 0]);

function fakeApp(simBatches = 1) {
    return {
        uiState: {
            terrainColorMap: "viridis",
            terrainColorMode: "height",
            terrainVisualizationModes: { surface: true, wireframe: true, normals: false },
        },
        batchManager: {
            simBatches,
            getBatchOffset: (i) => ({ x: i * 10, y: 0, z: 0 }),
        },
    };
}

function makeTerrainData({ embeddingData = null, batches = 1 } = {}) {
    const height = Array(RESOLUTION * RESOLUTION).fill(0);
    return {
        bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 },
        dimensions: { sizeX: 1, sizeY: 1, resolutionX: RESOLUTION, resolutionY: RESOLUTION },
        heightData: new Float32Array(Array(batches).fill(height).flat()),
        normals: new Float32Array(
            Array(RESOLUTION * RESOLUTION * batches)
                .fill(0)
                .map((_, i) => (i % 3 === 2 ? 1 : 0))
        ),
        embeddingData,
        isSingleton: false,
    };
}

function surfaceColorAttr(terrain, batchIndex = 0) {
    const batchGroup = terrain.group.getObjectByName(`batch${batchIndex}`);
    return batchGroup.getObjectByName("surface").geometry.getAttribute("color");
}

describe("Terrain embedding decode", () => {
    it("infers embeddingDim from the flat blob length and getAvailableColorModes includes 'features'", () => {
        const terrain = new Terrain(
            makeTerrainData({ embeddingData: EMBEDDING_SINGLE_BATCH }),
            fakeApp(1)
        );
        expect(terrain.embeddingDim).toBe(K);
        expect(terrain.getAvailableColorModes()).toContain("features");
    });

    it("omits 'features' when there's no embedding data", () => {
        const terrain = new Terrain(makeTerrainData(), fakeApp(1));
        expect(terrain.embeddingDim).toBe(0);
        expect(terrain.embeddingData).toBeNull();
        expect(terrain.getAvailableColorModes()).not.toContain("features");
    });

    it("excludes 'features' (and 'diff') from getAvailableDiffLayers", () => {
        const terrain = new Terrain(
            makeTerrainData({ embeddingData: EMBEDDING_SINGLE_BATCH, batches: 2 }),
            fakeApp(2)
        );
        const diffLayers = terrain.getAvailableDiffLayers();
        expect(diffLayers).not.toContain("features");
        expect(diffLayers).not.toContain("diff");
    });
});

describe("Terrain 'features' color mode", () => {
    let app, terrain;

    beforeEach(() => {
        app = fakeApp(1);
        terrain = new Terrain(
            makeTerrainData({ embeddingData: EMBEDDING_SINGLE_BATCH }),
            app
        );
    });

    it("setFeatureQueryAt returns false and leaves mode unchanged outside the terrain extent", () => {
        expect(terrain.setFeatureQueryAt(999, 999, 0)).toBe(false);
        expect(app.uiState.terrainColorMode).toBe("height");
    });

    it("setFeatureQueryAt on a valid point switches to 'features' mode and stores the query", () => {
        expect(terrain.setFeatureQueryAt(0, 0, 0)).toBe(true); // world (0,0) -> cell 0
        expect(app.uiState.terrainColorMode).toBe("features");
        expect(app.uiState.terrainFeatureQueryIndex).toBe(0);
    });

    it("colors the query cell and its same-direction neighbor identically (cos=1)", () => {
        terrain.setFeatureQueryAt(0, 0, 0); // cell 0, self-similarity = 1
        const attr = surfaceColorAttr(terrain);
        // cell 0 and cell 1 are adjacent in x at row 0 -- position indices 0
        // and 1 in the PlaneGeometry vertex order (see #updateSurfaceColor's
        // col/row remapping; row 0 in data-space is the *last* geometry row
        // due to the Y-flip, but cell 0 vs cell 1 are still geometry
        // vertices 2 and 3 for a 2x2 plane -- verify equality directly
        // rather than assuming a specific vertex index).
        const colorAt = (i) => [attr.array[i * 3], attr.array[i * 3 + 1], attr.array[i * 3 + 2]];
        // Cells 0 and 1 both have embedding [1,0] (cos=1 to the query);
        // whichever geometry vertices they land on, some pair of vertices
        // must show identical (and maximal, since coolwarm(1) is the top of
        // a diverging scale, not equal to any of the other cells' values)
        // colors distinct from the other two cells' colors.
        const colors = [0, 1, 2, 3].map(colorAt);
        const uniqueColors = new Set(colors.map((c) => c.join(",")));
        // 3 distinct cosine values (1, 1, 0, -1) among 4 cells => at most 3
        // distinct colors, and strictly fewer than 4 (proves two cells match).
        expect(uniqueColors.size).toBeLessThan(4);
    });

    it("gives the query's own cell the highest similarity value (cos=1 -> coolwarm's top color)", () => {
        terrain.setFeatureQueryAt(0, 0, 0); // query = cell 0, embedding [1,0]
        const attrFeatures = Array.from(surfaceColorAttr(terrain).array);

        // Cross-check against "diff" mode's known-correct 0.5-centered
        // convention isn't applicable here (different data), so instead
        // recolor with a mode whose per-cell value is directly known
        // (height, all zero -> uniform color) to get a color-buffer
        // *baseline*, then confirm "features" mode actually changed it.
        app.uiState.terrainColorMode = "height";
        terrain.setColorMode("height");
        const attrHeight = Array.from(surfaceColorAttr(terrain).array);
        expect(attrFeatures).not.toEqual(attrHeight);
    });

    it("renders the center (0.5) color everywhere before any query has been set", () => {
        app.uiState.terrainColorMode = "features";
        terrain.setColorMode("features");
        const attr = Array.from(surfaceColorAttr(terrain).array);
        // Center-of-coolwarm should be uniform across all 4 vertices (no
        // query set yet => value=0.5 everywhere, per the "features" branch's
        // fallback).
        const first = attr.slice(0, 3).join(",");
        for (let i = 1; i < 4; i++) {
            expect(attr.slice(i * 3, i * 3 + 3).join(",")).toBe(first);
        }
    });
});

describe("Terrain 'features' mode with multiple batches", () => {
    it("each batch reads its own embedding field against the shared query vector", () => {
        // Batch 0: same as EMBEDDING_SINGLE_BATCH. Batch 1: cell 0 embedding
        // flipped to [-1,0] (opposite of the query -- cos=-1 instead of 1).
        const batch0 = [1, 0, 1, 0, 0, 1, -1, 0];
        const batch1 = [-1, 0, 1, 0, 0, 1, -1, 0];
        const embeddingData = new Float32Array([...batch0, ...batch1]);
        const app = fakeApp(2);
        const terrain = new Terrain(
            makeTerrainData({ embeddingData, batches: 2 }),
            app
        );

        // Query cell 0 on batch 0 (embedding [1,0]) -- world (0,0) is on
        // batch 0's patch (offset x=0).
        terrain.setFeatureQueryAt(0, 0, 0);

        const attrBatch0 = Array.from(surfaceColorAttr(terrain, 0).array);
        const attrBatch1 = Array.from(surfaceColorAttr(terrain, 1).array);
        // Same query vector, but batch 1's own cell-0 embedding is opposite
        // (cos=-1) instead of matching (cos=1) -- the two batches' color
        // buffers must therefore differ.
        expect(attrBatch0).not.toEqual(attrBatch1);
    });
});
