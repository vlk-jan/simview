import { beforeEach, describe, expect, it } from "vitest";

// config.js reads window.devicePixelRatio at module load time (same stub
// other suites use). onClick also drives window.addEventListener at
// construction time and showTerrainTooltip/hideTerrainTooltip touch a
// handful of plain DOM APIs -- stubbed minimally here (plain objects, no
// jsdom) since none of that DOM plumbing is what's under test.
globalThis.window ??= {
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 800,
    innerHeight: 600,
};
globalThis.document ??= {
    getElementById: () => null,
    createElement: () => ({ style: {} }),
    body: { appendChild() {} },
};
const { InteractionController } = await import(
    "../../simview/static/js/components/InteractionController.js"
);

// Fake Body: matches the real class's public surface the controller touches
// (getObject3D().children, recolorBySimilarity), records calls instead of
// doing real THREE work.
function fakePointsBody(name, pointsObject) {
    return {
        recolorCalls: [],
        getObject3D: () => ({ children: [pointsObject] }),
        recolorBySimilarity(index) {
            this.recolorCalls.push(index);
        },
    };
}

function fakeApp({
    bodies = new Map(),
    terrain = null,
    terrainProbe = true,
    terrainColorMode = "height",
    pointColorMode = "similarity", // most tests below are about the click behavior itself
} = {}) {
    return {
        scene: {
            camera: {},
            renderer: null, // skips canvas listener setup; window listeners still attach
            addObject3D() {},
        },
        bodies,
        uiState: { terrainProbe, terrainColorMode, pointColorMode },
        terrain,
    };
}

// Stubs the raycaster so tests control intersection results directly instead
// of doing real THREE geometry math (which needs a real camera/scene). Both
// the body pass and the terrain pass go through intersectObjects; the
// terrain pass is recognised by its argument being the terrain's patches.
function stubRaycaster(controller, { objectHits = [], terrainHits = [] } = {}) {
    const patches = new Set(controller.app.terrain?.group?.children ?? []);
    controller.raycaster.setFromCamera = () => {};
    controller.raycaster.intersectObjects = (objs) =>
        objs.some((o) => patches.has(o)) ? terrainHits : objectHits;
}

// A terrain stub whose group holds one patch per hit object (or that
// object's batch group when it has one), the way Terrain.js lays them out.
function fakeTerrain(surfaceObjs, extra = {}) {
    return {
        group: { children: surfaceObjs.map((o) => o.parent ?? o) },
        ...extra,
    };
}

describe("InteractionController.onClick", () => {
    it("resolves bodies via Map iteration (regression: Object.values(Map) always returned [])", () => {
        const pointsObj = { isPoints: true, userData: { bodyName: "pts" } };
        const body = fakePointsBody("pts", pointsObj);
        const bodies = new Map([["pts", body]]);
        const app = fakeApp({ bodies });
        const controller = new InteractionController(app);

        let intersectObjectsArg = null;
        controller.raycaster.setFromCamera = () => {};
        controller.raycaster.intersectObjects = (objs) => {
            intersectObjectsArg = objs;
            return [];
        };

        controller.onClick({ clientX: 0, clientY: 0 });

        // The bug made this always [] regardless of how many bodies existed;
        // with the fix, the one body's points child must be present.
        expect(intersectObjectsArg).toEqual([pointsObj]);
    });

    it("clicking a point calls that body's recolorBySimilarity with the hit index", () => {
        const pointsObj = { isPoints: true, userData: { bodyName: "pts" } };
        const body = fakePointsBody("pts", pointsObj);
        const bodies = new Map([["pts", body]]);
        const app = fakeApp({ bodies });
        const controller = new InteractionController(app);
        stubRaycaster(controller, {
            objectHits: [{ object: pointsObj, index: 7, point: { x: 1, y: 2, z: 3 } }],
        });

        controller.onClick({ clientX: 0, clientY: 0 });

        expect(body.recolorCalls).toEqual([7]);
    });

    it("clicking a mesh (not points) selects it without calling recolorBySimilarity", () => {
        const pointsObj = { isPoints: true, userData: { bodyName: "pts" } };
        const meshObj = { isMesh: true };
        const body = fakePointsBody("pts", pointsObj);
        const bodies = new Map([["pts", body]]);
        const app = fakeApp({ bodies });
        const controller = new InteractionController(app);
        stubRaycaster(controller, {
            objectHits: [{ object: meshObj, point: { x: 0, y: 0, z: 0 } }],
        });

        controller.onClick({ clientX: 0, clientY: 0 });

        expect(controller.selectedObject).toBe(meshObj);
        expect(body.recolorCalls).toEqual([]);
    });

    it("clicking terrain in 'features' mode calls setFeatureQueryAt instead of showing the props tooltip", () => {
        const surfaceObj = { name: "surface", parent: { name: "batch1", parent: null } };
        const calls = [];
        const terrain = fakeTerrain([surfaceObj], {
            setFeatureQueryAt(x, y, batchIndex) {
                calls.push([x, y, batchIndex]);
                return true;
            },
        });
        const app = fakeApp({ terrain, terrainColorMode: "features" });
        const controller = new InteractionController(app);
        stubRaycaster(controller, {
            objectHits: [],
            terrainHits: [{ object: surfaceObj, point: { x: 1.5, y: 2.5, z: 0 } }],
        });

        controller.onClick({ clientX: 0, clientY: 0 });

        expect(calls).toEqual([[1.5, 2.5, 1]]);
    });

    it("clicking terrain in a non-'features' mode does not call setFeatureQueryAt", () => {
        const surfaceObj = { name: "surface", parent: null };
        let called = false;
        const terrain = fakeTerrain([surfaceObj], {
            setFeatureQueryAt() {
                called = true;
                return true;
            },
            getPropertiesAt: () => null, // no props -> showTerrainTooltip bails out early
        });
        const app = fakeApp({ terrain, terrainColorMode: "height" });
        const controller = new InteractionController(app);
        stubRaycaster(controller, {
            objectHits: [],
            terrainHits: [{ object: surfaceObj, point: { x: 0, y: 0, z: 0 } }],
        });

        controller.onClick({ clientX: 0, clientY: 0 });

        expect(called).toBe(false);
    });

    it("clicking a point in 'pca' mode does NOT call recolorBySimilarity (similarity must be chosen first)", () => {
        const pointsObj = { isPoints: true, userData: { bodyName: "pts" } };
        const body = fakePointsBody("pts", pointsObj);
        const bodies = new Map([["pts", body]]);
        const app = fakeApp({ bodies, pointColorMode: "pca" });
        const controller = new InteractionController(app);
        stubRaycaster(controller, {
            objectHits: [{ object: pointsObj, index: 7, point: { x: 1, y: 2, z: 3 } }],
        });

        controller.onClick({ clientX: 0, clientY: 0 });

        expect(body.recolorCalls).toEqual([]);
        expect(controller.selectedObject).toBe(pointsObj);
    });

    it("clicking a point with no pointColorMode set at all does NOT call recolorBySimilarity", () => {
        const pointsObj = { isPoints: true, userData: { bodyName: "pts" } };
        const body = fakePointsBody("pts", pointsObj);
        const bodies = new Map([["pts", body]]);
        const app = fakeApp({ bodies });
        delete app.uiState.pointColorMode; // genuinely absent, not just defaulted by fakeApp()
        const controller = new InteractionController(app);
        stubRaycaster(controller, {
            objectHits: [{ object: pointsObj, index: 7, point: { x: 1, y: 2, z: 3 } }],
        });

        controller.onClick({ clientX: 0, clientY: 0 });

        expect(body.recolorCalls).toEqual([]);
    });

    it("clicking a point in 'similarity' mode does call recolorBySimilarity", () => {
        const pointsObj = { isPoints: true, userData: { bodyName: "pts" } };
        const body = fakePointsBody("pts", pointsObj);
        const bodies = new Map([["pts", body]]);
        const app = fakeApp({ bodies, pointColorMode: "similarity" });
        const controller = new InteractionController(app);
        stubRaycaster(controller, {
            objectHits: [{ object: pointsObj, index: 3, point: { x: 1, y: 2, z: 3 } }],
        });

        controller.onClick({ clientX: 0, clientY: 0 });

        expect(body.recolorCalls).toEqual([3]);
    });

    it("does nothing at all (no raycast, no selection) when neither probe nor similarity is active", () => {
        const pointsObj = { isPoints: true, userData: { bodyName: "pts" } };
        const body = fakePointsBody("pts", pointsObj);
        const bodies = new Map([["pts", body]]);
        const app = fakeApp({ bodies, terrainProbe: false, pointColorMode: "pca" });
        const controller = new InteractionController(app);
        let raycastCalled = false;
        controller.raycaster.setFromCamera = () => {
            raycastCalled = true;
        };
        controller.raycaster.intersectObjects = () => [{ object: pointsObj, index: 0, point: { x: 0, y: 0, z: 0 } }];

        controller.onClick({ clientX: 0, clientY: 0 });

        expect(raycastCalled).toBe(false);
        expect(controller.selectedObject).toBeNull();
        expect(body.recolorCalls).toEqual([]);
    });

    it("proceeds (probe only) when probe is active even if pointColorMode is 'pca'", () => {
        const surfaceObj = { name: "surface", parent: null };
        const terrain = fakeTerrain([surfaceObj], { getPropertiesAt: () => null });
        const app = fakeApp({ terrain, terrainProbe: true, pointColorMode: "pca" });
        const controller = new InteractionController(app);
        let raycastCalled = false;
        stubRaycaster(controller, {
            terrainHits: [{ object: surfaceObj, point: { x: 0, y: 0, z: 0 } }],
        });
        controller.raycaster.setFromCamera = () => {
            raycastCalled = true;
        };

        controller.onClick({ clientX: 0, clientY: 0 });

        expect(raycastCalled).toBe(true);
    });

    it("proceeds (similarity only) when similarity is active even if probe is off", () => {
        const pointsObj = { isPoints: true, userData: { bodyName: "pts" } };
        const body = fakePointsBody("pts", pointsObj);
        const app = fakeApp({ bodies: new Map([["pts", body]]), terrainProbe: false, pointColorMode: "similarity" });
        const controller = new InteractionController(app);
        stubRaycaster(controller, {
            objectHits: [{ object: pointsObj, index: 2, point: { x: 0, y: 0, z: 0 } }],
        });

        controller.onClick({ clientX: 0, clientY: 0 });

        expect(body.recolorCalls).toEqual([2]);
    });

    it("does nothing when the click was actually a drag (>5px movement)", () => {
        const pointsObj = { isPoints: true, userData: { bodyName: "pts" } };
        const body = fakePointsBody("pts", pointsObj);
        const app = fakeApp({ bodies: new Map([["pts", body]]) });
        const controller = new InteractionController(app);
        stubRaycaster(controller, {
            objectHits: [{ object: pointsObj, index: 0, point: { x: 0, y: 0, z: 0 } }],
        });
        controller.lastMouseDown = { x: 0, y: 0 };

        controller.onClick({ clientX: 20, clientY: 20 });

        expect(body.recolorCalls).toEqual([]);
    });
});

describe("InteractionController.onClick ignores what isn't on screen", () => {
    it("leaves hidden body objects and hidden bodies out of the raycast", () => {
        const shown = { isPoints: true, visible: true, userData: { bodyName: "a" } };
        const hidden = { isPoints: true, visible: false, userData: { bodyName: "a" } };
        const bodyA = { getObject3D: () => ({ visible: true, children: [shown, hidden] }) };
        const bodyB = { getObject3D: () => ({ visible: false, children: [{ isMesh: true, visible: true }] }) };
        const app = fakeApp({ bodies: new Map([["a", bodyA], ["b", bodyB]]) });
        const controller = new InteractionController(app);
        let arg = null;
        controller.raycaster.setFromCamera = () => {};
        controller.raycaster.intersectObjects = (objs) => {
            arg = arg ?? objs;
            return [];
        };

        controller.onClick({ clientX: 0, clientY: 0 });

        expect(arg).toEqual([shown]);
    });

    it("raycasts only the visible terrain patches", () => {
        const shownPatch = { name: "batch0", visible: true };
        const hiddenPatch = { name: "batch1", visible: false };
        const terrain = { group: { children: [shownPatch, hiddenPatch] }, getPropertiesAt: () => null };
        const app = fakeApp({ terrain, pointColorMode: "pca" });
        const controller = new InteractionController(app);
        const args = [];
        controller.raycaster.setFromCamera = () => {};
        controller.raycaster.intersectObjects = (objs) => {
            args.push(objs);
            return [];
        };

        controller.onClick({ clientX: 0, clientY: 0 });

        expect(args[1]).toEqual([shownPatch]);
    });

    it("ignores a click whose target is not the renderer canvas (UI panels over the view)", () => {
        const canvas = { addEventListener() {}, removeEventListener() {} };
        const app = fakeApp({ terrain: fakeTerrain([]) });
        app.scene.renderer = { domElement: canvas };
        const controller = new InteractionController(app);
        let raycasts = 0;
        controller.raycaster.setFromCamera = () => raycasts++;
        controller.raycaster.intersectObjects = () => [];

        controller.onClick({ clientX: 0, clientY: 0, target: { tagName: "INPUT" } });
        expect(raycasts).toBe(0);

        controller.onClick({ clientX: 0, clientY: 0, target: canvas });
        expect(raycasts).toBe(1);
    });
});
