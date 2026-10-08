import { beforeEach, describe, expect, it } from "vitest";

// Terrain.js pulls in config.js, which reads `window.devicePixelRatio` at
// module load time (same stub AnimationController's/ErrorMetrics' suites
// use) -- js-colormaps.js (the other sibling import) is pure data/functions
// with no module-load DOM access, so no other stubbing is needed to
// construct a real Terrain instance under Node.
globalThis.window ??= { devicePixelRatio: 1 };
const { Terrain } = await import("../../simview/static/js/objects/Terrain.js");

// 2x2 grid (resolutionX=resolutionY=2), extent [0,1]x[0,1], row-major
// (row=y, col=x): index 0=(x0,y0), 1=(x1,y0), 2=(x0,y1), 3=(x1,y1).
const RESOLUTION = 2;
const HEIGHT_A = [0, 1, 2, 3];
const HEIGHT_B = [0, 1, 2, 3]; // identical height -- only friction differs
const FRICTION_A = [0.3, 0.3, 0.3, 0.3];
const FRICTION_B = [0.3, 0.3, 0.9, 0.3]; // cell index 2 (x0,y1) bumped

function fakeApp(simBatches = 2) {
    const app = {
        uiState: {
            terrainColorMap: "viridis",
            terrainColorMode: "height",
            terrainVisualizationModes: { surface: true, wireframe: true, normals: false },
        },
        batchManager: {
            simBatches,
            // Lay batches out 10 units apart in world X, like the real
            // BatchManager does, so a naive "reuse the same world point for
            // every batch" bug (re-deriving local coords per batch from an
            // already-batch-offset-corrected point) would show up as wrong
            // grid cells for batch 1 in the tests below.
            getBatchOffset: (i) => ({ x: i * 10, y: 0, z: 0 }),
        },
    };
    return app;
}

function makeTerrainData(isSingleton = false) {
    // A real singleton terrain's wire data is the *same* values broadcast to
    // every batch (see model.py's `SimViewTerrain.create` repeat()), so a
    // singleton fixture must use identical per-batch chunks -- unlike the
    // non-singleton fixture below, which deliberately differs so diff/probe
    // math has something to detect.
    const frictionB = isSingleton ? FRICTION_A : FRICTION_B;
    return {
        bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 3 },
        dimensions: { sizeX: 1, sizeY: 1, resolutionX: RESOLUTION, resolutionY: RESOLUTION },
        heightData: new Float32Array([...HEIGHT_A, ...HEIGHT_B]),
        properties: {
            friction: {
                data: new Float32Array([...FRICTION_A, ...frictionB]),
                min: 0.3,
                max: 0.9,
            },
        },
        normals: new Float32Array(
            Array(RESOLUTION * RESOLUTION * 2 * 3)
                .fill(0)
                .map((_, i) => (i % 3 === 2 ? 1 : 0))
        ),
        isSingleton,
    };
}

describe("Terrain.getPropertiesAt / getPropertiesAtAllBatches", () => {
    let app, terrain;

    beforeEach(() => {
        app = fakeApp(2);
        terrain = new Terrain(makeTerrainData(false), app);
    });

    it("getPropertiesAt reads the hovered batch's own data at its world offset", () => {
        // World point (10, 1) is local (0, 1) on batch 1's patch (offset by
        // x=10) -- grid cell index 2 -> friction 0.9 for batch 1.
        const props = terrain.getPropertiesAt(10, 1, 1);
        expect(props.friction).toBeCloseTo(0.9);
    });

    it("getPropertiesAt on batch 0 at the equivalent local cell sees the unmodified value", () => {
        const props = terrain.getPropertiesAt(0, 1, 0);
        expect(props.friction).toBeCloseTo(0.3);
    });

    it("getPropertiesAtAllBatches resolves the grid cell once (via the hovered batch's offset) and reads every batch at that same cell", () => {
        // Hover on batch 1's patch (world x=10 -> local x=0), at local y=1.
        const all = terrain.getPropertiesAtAllBatches(10, 1, 1);
        expect(all).not.toBeNull();
        expect(all.get(0).friction).toBeCloseTo(0.3);
        expect(all.get(1).friction).toBeCloseTo(0.9);
    });

    it("getPropertiesAtAllBatches called via batch 0's own patch resolves the same shared cell", () => {
        // Hover on batch 0's patch (world x=0, no offset), same local cell.
        const all = terrain.getPropertiesAtAllBatches(0, 1, 0);
        expect(all.get(0).friction).toBeCloseTo(0.3);
        expect(all.get(1).friction).toBeCloseTo(0.9);
    });

    it("returns null outside the terrain extent", () => {
        expect(terrain.getPropertiesAtAllBatches(999, 999, 0)).toBeNull();
        expect(terrain.getPropertiesAt(999, 999, 0)).toBeNull();
    });
});

describe("Terrain singleton data layouts", () => {
    it("splits a deduplicated singleton terrain (one shared copy) into a single batch entry", () => {
        // Modern singleton wire format: exactly one resolution-sized copy of
        // every field, isSingleton=true (see model.py create_terrain).
        const data = {
            bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 3 },
            dimensions: { sizeX: 1, sizeY: 1, resolutionX: RESOLUTION, resolutionY: RESOLUTION },
            heightData: new Float32Array(HEIGHT_A),
            properties: {
                friction: { data: new Float32Array(FRICTION_A), min: 0.3, max: 0.9 },
            },
            normals: new Float32Array(
                Array(RESOLUTION * RESOLUTION * 3)
                    .fill(0)
                    .map((_, i) => (i % 3 === 2 ? 1 : 0))
            ),
            isSingleton: true,
        };
        const terrain = new Terrain(data, fakeApp(2));

        expect(terrain.heightData.length).toBe(1);
        expect(terrain.properties.get("friction").length).toBe(1);
        // Every batch's probe reads the one shared copy.
        const all = terrain.getPropertiesAtAllBatches(10, 1, 1);
        expect(all.get(0).friction).toBeCloseTo(0.3);
        expect(all.get(1).friction).toBeCloseTo(0.3);
        expect(all.get(1).height).toBeCloseTo(2);
    });

    it("still splits a legacy broadcast singleton (simBatches identical copies) per batch", () => {
        const terrain = new Terrain(makeTerrainData(true), fakeApp(2));
        expect(terrain.heightData.length).toBe(2);
        const all = terrain.getPropertiesAtAllBatches(10, 1, 1);
        expect(all.get(0).friction).toBeCloseTo(0.3);
        expect(all.get(1).friction).toBeCloseTo(0.3);
    });
});

describe("Terrain diff overlay helpers", () => {
    it("getAvailableColorModes includes 'diff' only with 2+ batches", () => {
        const single = new Terrain(makeTerrainData(false), fakeApp(1));
        expect(single.getAvailableColorModes()).not.toContain("diff");

        const multi = new Terrain(makeTerrainData(false), fakeApp(2));
        expect(multi.getAvailableColorModes()).toContain("diff");
    });

    it("getDiffMaxAbsDelta reflects the configured diff layer/batch pair", () => {
        const app = fakeApp(2);
        app.uiState.terrainDiffLayer = "friction";
        app.uiState.terrainDiffBatchA = 0;
        app.uiState.terrainDiffBatchB = 1;
        const terrain = new Terrain(makeTerrainData(false), app);
        // Only cell index 2 differs: |0.9 - 0.3| = 0.6.
        expect(terrain.getDiffMaxAbsDelta()).toBeCloseTo(0.6);
    });

    it("getDiffMaxAbsDelta is 0 for a singleton terrain (same data every batch)", () => {
        const app = fakeApp(2);
        app.uiState.terrainDiffLayer = "friction";
        app.uiState.terrainDiffBatchA = 0;
        app.uiState.terrainDiffBatchB = 1;
        const terrain = new Terrain(makeTerrainData(true), app);
        expect(terrain.getDiffMaxAbsDelta()).toBe(0);
    });
});

describe("Terrain surface shading normals", () => {
    function dataWithNormals(normals) {
        const data = makeTerrainData(false);
        data.normals = normals;
        return data;
    }

    it("writes the supplied normals (normalized, row-inverted like the heights) into the geometry", () => {
        // Per-cell normal (dataIndex, 0, 1), deliberately unnormalized.
        const perBatch = [];
        for (let d = 0; d < RESOLUTION * RESOLUTION; d++) perBatch.push(d, 0, 1);
        const terrain = new Terrain(
            dataWithNormals(new Float32Array([...perBatch, ...perBatch])),
            fakeApp(2)
        );
        const normal = terrain.group.getObjectByName("batch0").getObjectByName("surface")
            .geometry.attributes.normal;
        // Vertex 0 is the top-left of the plane, i.e. data row 1, col 0 -> dataIndex 2.
        const len = Math.hypot(2, 0, 1);
        expect(normal.getX(0)).toBeCloseTo(2 / len);
        expect(normal.getZ(0)).toBeCloseTo(1 / len);
        // Vertex 2 is data row 0, col 0 -> dataIndex 0 -> (0, 0, 1).
        expect(normal.getX(2)).toBeCloseTo(0);
        expect(normal.getZ(2)).toBeCloseTo(1);
    });

    it("computes normals from the heightfield when none are supplied", () => {
        const data = makeTerrainData(false);
        delete data.normals;
        const terrain = new Terrain(data, fakeApp(2));
        const normal = terrain.group.getObjectByName("batch0").getObjectByName("surface")
            .geometry.attributes.normal;
        // Heights ramp 0..3 across the 1x1 extent, so a flat (0, 0, 1)
        // normal -- PlaneGeometry's default -- would mean nothing was computed.
        expect(Math.abs(normal.getZ(0))).toBeLessThan(0.99);
    });
});

describe("Terrain robustness", () => {
    it("colours a NaN property cell neutral grey without hitting js-colormaps' alert()", () => {
        globalThis.alert = () => {
            throw new Error("alert() must not fire");
        };
        try {
            const data = makeTerrainData(false);
            data.properties.friction.data = new Float32Array([0.3, NaN, 0.3, 0.3, ...FRICTION_B]);
            const app = fakeApp(2);
            app.uiState.terrainColorMode = "friction";
            const terrain = new Terrain(data, app);
            const color = terrain.group.getObjectByName("batch0").getObjectByName("surface")
                .geometry.attributes.color;
            // dataIndex 1 (row 0, col 1) is vertex 3 after the row inversion.
            expect(color.getX(3)).toBeCloseTo(0.5);
            expect(color.getY(3)).toBeCloseTo(0.5);
            expect(color.getZ(3)).toBeCloseTo(0.5);
        } finally {
            delete globalThis.alert;
        }
    });

    it("accepts hand-authored embeddingData as a per-batch nested list", () => {
        const data = makeTerrainData(false);
        const K = 2;
        const perBatch = Array.from({ length: RESOLUTION * RESOLUTION * K }, (_, i) => i);
        data.embeddingData = [perBatch, perBatch.map((v) => -v)];
        const terrain = new Terrain(data, fakeApp(2));
        expect(terrain.embeddingDim).toBe(K);
        expect(terrain.embeddingData.length).toBe(2);
        expect(terrain.getAvailableColorModes()).toContain("features");
    });

    it("dispose removes the terrain group from its parent", () => {
        const terrain = new Terrain(makeTerrainData(false), fakeApp(2));
        const parent = { children: [], remove(o) { this.removed = o; } };
        terrain.group.parent = parent;
        terrain.dispose();
        expect(parent.removed).toBeDefined();
        expect(terrain.group).toBeNull();
    });
});
