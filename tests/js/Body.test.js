import { beforeEach, describe, expect, it } from "vitest";

// config.js reads window.devicePixelRatio at module load time (same stub
// Terrain.test.js/AnimationController.test.js use). Body.js's points
// representation always requests a texture (BODY_CONFIG.points.texture in
// config.js), so THREE.TextureLoader().load() needs a minimal `document`
// too -- it only calls createElementNS('img') + add/removeEventListener,
// never actually resolves the image, which is fine: tests here don't need
// real texture pixels, just a Body that constructs without throwing.
globalThis.window ??= { devicePixelRatio: 1 };
globalThis.document ??= {
    createElementNS: () => ({
        addEventListener() {},
        removeEventListener() {},
    }),
};
const { Body } = await import("../../simview/static/js/objects/Body.js");

function fakeApp(simBatches = 1) {
    return {
        batchManager: {
            simBatches,
            getBatchOffset: () => ({ x: 0, y: 0, z: 0 }),
        },
        uiState: {
            bodyVisualizationMode: "points",
            axesVisible: false,
            attributeVisible: {},
        },
        animationController: null,
    };
}

// 4 points in a line, embedding chosen so points 0/1 are near-identical
// vectors (cosine ~1) and points 2/3 point the opposite way (cosine ~-1),
// giving recolorBySimilarity something unambiguous to distinguish.
const N = 4;
const K = 3;
const POINTS = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]);
const COLORS = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0]);
const EMBEDDING = new Float32Array([
    1, 0, 0, // point 0
    2, 0, 0, // point 1 -- same direction as 0, cosine sim = 1
    0, 1, 0, // point 2 -- orthogonal to 0, cosine sim = 0
    -1, 0, 0, // point 3 -- opposite of 0, cosine sim = -1
]);

function makePointcloudBodyData(overrides = {}) {
    return {
        name: "wi_features",
        shape: {
            type: "pointcloud",
            points: POINTS,
            ...overrides,
        },
    };
}

describe("Body pointcloud color/embedding", () => {
    it("constructs cleanly under Node for a plain pointcloud body (no color/embedding)", () => {
        const body = new Body(makePointcloudBodyData(), fakeApp());
        expect(body.pointCount).toBe(N);
        expect(body.pointColors).toBeNull();
        expect(body.pointEmbedding).toBeNull();
        expect(body.embeddingDim).toBe(0);
    });

    it("decodes shape.color/shape.embedding and infers embeddingDim from flat length", () => {
        const body = new Body(
            makePointcloudBodyData({ color: COLORS, embedding: EMBEDDING }),
            fakeApp()
        );
        expect(body.pointColors).toEqual(COLORS);
        expect(body.pointEmbedding).toEqual(EMBEDDING);
        expect(body.embeddingDim).toBe(K);
    });

    it("applies the static color as the initial per-point color buffer", () => {
        const body = new Body(
            makePointcloudBodyData({ color: COLORS }),
            fakeApp()
        );
        const points = body.representations.points[0];
        expect(points.material.vertexColors).toBe(true);
        const attr = points.geometry.getAttribute("color");
        expect(Array.from(attr.array)).toEqual(Array.from(COLORS));
    });

    it("tags each batch's points object with bodyName/batchIndex for raycast resolution", () => {
        const body = new Body(makePointcloudBodyData(), fakeApp(2));
        for (let i = 0; i < 2; i++) {
            const points = body.representations.points[i];
            expect(points.userData.bodyName).toBe("wi_features");
            expect(points.userData.batchIndex).toBe(i);
        }
    });

    describe("recolorBySimilarity / resetPointColors", () => {
        let body;
        beforeEach(() => {
            body = new Body(
                makePointcloudBodyData({ color: COLORS, embedding: EMBEDDING }),
                fakeApp()
            );
        });

        it("does nothing (no throw) when there's no embedding", () => {
            const bodyNoEmbed = new Body(
                makePointcloudBodyData({ color: COLORS }),
                fakeApp()
            );
            expect(() => bodyNoEmbed.recolorBySimilarity(0)).not.toThrow();
        });

        it("colors the query point itself at the top of the colormap (cosine = 1)", () => {
            body.recolorBySimilarity(0, "grayscale");
            const attr = body.representations.points[0].geometry.getAttribute("color");
            // grayscale colormap: value -> (value, value, value); cosine=1 -> value=1
            expect(attr.array[0]).toBeCloseTo(1, 5);
            expect(attr.array[1]).toBeCloseTo(1, 5);
            expect(attr.array[2]).toBeCloseTo(1, 5);
        });

        it("colors a same-direction point identically to the query (point 1, cosine ~1)", () => {
            body.recolorBySimilarity(0, "grayscale");
            const attr = body.representations.points[0].geometry.getAttribute("color");
            const qColor = [attr.array[0], attr.array[1], attr.array[2]];
            const p1Color = [attr.array[3], attr.array[4], attr.array[5]];
            expect(p1Color[0]).toBeCloseTo(qColor[0], 5);
        });

        it("colors the opposite-direction point at the bottom of the colormap (point 3, cosine = -1)", () => {
            body.recolorBySimilarity(0, "grayscale");
            const attr = body.representations.points[0].geometry.getAttribute("color");
            // cosine=-1 -> value=0 -> grayscale (0,0,0)
            expect(attr.array[9]).toBeCloseTo(0, 5);
            expect(attr.array[10]).toBeCloseTo(0, 5);
            expect(attr.array[11]).toBeCloseTo(0, 5);
        });

        it("sets selectedPointIndex to the queried point", () => {
            body.recolorBySimilarity(2);
            expect(body.selectedPointIndex).toBe(2);
        });

        it("resetPointColors restores the original static color and clears selection", () => {
            body.recolorBySimilarity(0);
            body.resetPointColors();
            const attr = body.representations.points[0].geometry.getAttribute("color");
            expect(Array.from(attr.array)).toEqual(Array.from(COLORS));
            expect(body.selectedPointIndex).toBeNull();
        });

        it("recolors every batch's points object, not just batch 0", () => {
            const multiBatchBody = new Body(
                makePointcloudBodyData({ color: COLORS, embedding: EMBEDDING }),
                fakeApp(3)
            );
            multiBatchBody.recolorBySimilarity(0, "grayscale");
            for (let i = 0; i < 3; i++) {
                const attr = multiBatchBody.representations.points[i].geometry.getAttribute("color");
                expect(attr.array[0]).toBeCloseTo(1, 5);
            }
        });
    });

    describe("recolorBySimilarity / resetPointColors sync the GUI dropdown and legend", () => {
        // Fake lil-gui controller: just enough surface (getValue/setValue) for
        // Body.js to drive it the same way Terrain.setFeatureQueryAt does.
        function fakeController(initial = "pca") {
            return {
                value: initial,
                getValue() {
                    return this.value;
                },
                setValue(v) {
                    this.value = v;
                },
            };
        }

        it("recolorBySimilarity switches the 'pointColorMode' controller to 'similarity'", () => {
            const controller = fakeController("pca");
            const app = fakeApp();
            app.uiControls = { findController: (name) => (name === "pointColorMode" ? controller : null) };
            const body = new Body(makePointcloudBodyData({ color: COLORS, embedding: EMBEDDING }), app);

            body.recolorBySimilarity(0);

            expect(controller.getValue()).toBe("similarity");
        });

        it("recolorBySimilarity does not touch the controller if it's already 'similarity'", () => {
            const controller = fakeController("similarity");
            let setValueCalls = 0;
            controller.setValue = function (v) {
                setValueCalls++;
                this.value = v;
            };
            const app = fakeApp();
            app.uiControls = { findController: () => controller };
            const body = new Body(makePointcloudBodyData({ color: COLORS, embedding: EMBEDDING }), app);

            body.recolorBySimilarity(0);

            expect(setValueCalls).toBe(0);
        });

        it("recolorBySimilarity tolerates a missing uiControls (e.g. no GUI at all)", () => {
            const app = fakeApp(); // no uiControls
            const body = new Body(makePointcloudBodyData({ color: COLORS, embedding: EMBEDDING }), app);
            expect(() => body.recolorBySimilarity(0)).not.toThrow();
        });

        it("recolorBySimilarity calls legend.update() when a legend exists", () => {
            let updateCalls = 0;
            const app = fakeApp();
            app.legend = { update: () => updateCalls++ };
            const body = new Body(makePointcloudBodyData({ color: COLORS, embedding: EMBEDDING }), app);

            body.recolorBySimilarity(0);

            expect(updateCalls).toBe(1);
        });

        it("resetPointColors calls legend.update() too", () => {
            let updateCalls = 0;
            const app = fakeApp();
            app.legend = { update: () => updateCalls++ };
            const body = new Body(makePointcloudBodyData({ color: COLORS, embedding: EMBEDDING }), app);
            body.recolorBySimilarity(0);
            updateCalls = 0; // reset after the recolor's own call

            body.resetPointColors();

            expect(updateCalls).toBe(1);
        });

        it("resetPointColors tolerates a missing legend", () => {
            const app = fakeApp(); // no legend
            const body = new Body(makePointcloudBodyData({ color: COLORS, embedding: EMBEDDING }), app);
            expect(() => body.resetPointColors()).not.toThrow();
        });
    });
});
