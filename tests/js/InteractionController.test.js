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

function fakeApp({ bodies = new Map(), terrain = null, terrainProbe = true, terrainColorMode = "height" } = {}) {
    return {
        scene: {
            camera: {},
            renderer: null, // skips canvas listener setup; window listeners still attach
            addObject3D() {},
        },
        bodies,
        uiState: { terrainProbe, terrainColorMode },
        terrain,
    };
}

// Stubs the raycaster so tests control intersection results directly instead
// of doing real THREE geometry math (which needs a real camera/scene).
function stubRaycaster(controller, { objectHits = [], terrainHits = [] } = {}) {
    controller.raycaster.setFromCamera = () => {};
    controller.raycaster.intersectObjects = () => objectHits;
    controller.raycaster.intersectObject = () => terrainHits;
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
        const terrain = {
            group: {},
            setFeatureQueryAt(x, y, batchIndex) {
                calls.push([x, y, batchIndex]);
                return true;
            },
        };
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
        const terrain = {
            group: {},
            setFeatureQueryAt() {
                called = true;
                return true;
            },
            getPropertiesAt: () => null, // no props -> showTerrainTooltip bails out early
        };
        const app = fakeApp({ terrain, terrainColorMode: "height" });
        const controller = new InteractionController(app);
        stubRaycaster(controller, {
            objectHits: [],
            terrainHits: [{ object: surfaceObj, point: { x: 0, y: 0, z: 0 } }],
        });

        controller.onClick({ clientX: 0, clientY: 0 });

        expect(called).toBe(false);
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
