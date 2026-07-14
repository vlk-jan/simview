import { beforeEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { buildBodyMeta, topoSortBodies } from "../../simview/static/js/utils/bodyTransforms.js";

// AnimationController.js pulls in PlaybackControls.js, which pulls in
// config.js -- and config.js reads `window.devicePixelRatio` at module load
// time for RENDERER_CONFIG. That's fine in the browser (and unrelated to
// anything under test here), but this suite runs under Vitest's plain "node"
// environment (see vitest.config.js), which has no `window` global at all.
// A minimal stub before the (dynamic, so it runs after this assignment)
// import satisfies that module-load-time read without pulling in jsdom just
// for this.
globalThis.window ??= { devicePixelRatio: 1 };
const { AnimationController } = await import(
    "../../simview/static/js/components/AnimationController.js"
);

// Minimal fake StateStore: a plain array of {time, bodies} frames, matching
// the same API surface AnimationController actually calls (timeAt, lastTime,
// length, getFrame) -- no need to pull in the real Columnar/LegacyStateStore.
function fakeStore(frames) {
    return {
        length: frames.length,
        timeAt: (i) => frames[i].time,
        lastTime: () => frames[frames.length - 1].time,
        getFrame: (i) => frames[i],
    };
}

function transformRow(x, quat = new THREE.Quaternion()) {
    return [x, 0, 0, quat.w, quat.x, quat.y, quat.z];
}

// Records every bodyState passed to updateState() so tests can inspect the
// interpolated/snapped values the controller actually computed.
class RecordingBody {
    constructor() {
        this.calls = [];
    }
    updateState(bodyState) {
        this.calls.push(bodyState);
    }
}

function makeApp({ smoothInterpolation = true } = {}) {
    const bodyMeta = buildBodyMeta([{ name: "a" }]);
    const bodyTopoOrder = topoSortBodies(bodyMeta);
    const body = new RecordingBody();
    return {
        bodyMeta,
        bodyTopoOrder,
        batchManager: { simBatches: 1 },
        bodies: new Map([["a", body]]),
        uiState: { smoothInterpolation },
        scalarPlotter: null,
        bodyStateWindow: null,
        _body: body,
    };
}

describe("AnimationController.getBracketingIndices", () => {
    let ac;
    beforeEach(() => {
        ac = new AnimationController(makeApp());
        ac.store = fakeStore([
            { time: 0, bodies: [] },
            { time: 1, bodies: [] },
            { time: 2, bodies: [] },
        ]);
        ac.totalTime = 2;
    });

    it("returns alpha 0 at the very start", () => {
        expect(ac.getBracketingIndices(0)).toEqual({ lo: 0, hi: 1, alpha: 0 });
    });

    it("returns alpha 1 at the very end", () => {
        expect(ac.getBracketingIndices(2)).toEqual({ lo: 1, hi: 2, alpha: 1 });
    });

    it("returns the bracketing pair and fractional alpha mid-interval", () => {
        expect(ac.getBracketingIndices(0.25)).toEqual({ lo: 0, hi: 1, alpha: 0.25 });
        expect(ac.getBracketingIndices(1.5)).toEqual({ lo: 1, hi: 2, alpha: 0.5 });
    });

    it("guards division by zero for an all-duplicate-timestamp store (zero-width bracket)", () => {
        // Every frame shares the same timestamp, so whichever pair
        // getBracketingIndices lands on has zero span -- must produce a
        // finite alpha, never NaN, regardless of which branch is taken.
        ac.store = fakeStore([
            { time: 5, bodies: [] },
            { time: 5, bodies: [] },
            { time: 5, bodies: [] },
        ]);
        const { lo, hi, alpha } = ac.getBracketingIndices(5);
        expect(hi).toBe(lo + 1);
        expect(Number.isNaN(alpha)).toBe(false);
    });
});

describe("AnimationController interpolated updateScene", () => {
    it("renders a blended pose partway between two recorded states", () => {
        const app = makeApp({ smoothInterpolation: true });
        const ac = new AnimationController(app);
        ac.store = fakeStore([
            { time: 0, bodies: [{ name: "a", bodyTransform: transformRow(0) }] },
            { time: 1, bodies: [{ name: "a", bodyTransform: transformRow(10) }] },
        ]);
        ac.totalTime = 1;
        ac.currentStateIndex = 0;
        ac.currentTime = 0.5;

        ac.updateScene();

        expect(app._body.calls).toHaveLength(1);
        const [{ bodyTransform }] = app._body.calls;
        const row = Array.isArray(bodyTransform[0]) ? bodyTransform[0] : bodyTransform;
        expect(row[0]).toBeCloseTo(5, 10);
    });

    it("reuses the cached bracketing frames for a second tick in the same interval", () => {
        const app = makeApp({ smoothInterpolation: true });
        const ac = new AnimationController(app);
        let resolveCalls = 0;
        const frames = [
            { time: 0, bodies: [{ name: "a", bodyTransform: transformRow(0) }] },
            { time: 1, bodies: [{ name: "a", bodyTransform: transformRow(10) }] },
        ];
        const store = fakeStore(frames);
        const originalGetFrame = store.getFrame;
        store.getFrame = (i) => {
            resolveCalls++;
            return originalGetFrame(i);
        };
        ac.store = store;
        ac.totalTime = 1;
        ac.currentStateIndex = 0;

        ac.currentTime = 0.2;
        ac.updateScene();
        const callsAfterFirst = resolveCalls;

        ac.currentTime = 0.8;
        ac.updateScene();

        // Both ticks fall within the same (lo=0, hi=1) bracket, so the second
        // updateScene() should not re-fetch/re-resolve either frame.
        expect(resolveCalls).toBe(callsAfterFirst);
    });

    it("falls back to nearest-frame snapping when smoothInterpolation is off (byte-identical to today)", () => {
        const app = makeApp({ smoothInterpolation: false });
        const ac = new AnimationController(app);
        ac.store = fakeStore([
            { time: 0, bodies: [{ name: "a", bodyTransform: transformRow(0) }] },
            { time: 1, bodies: [{ name: "a", bodyTransform: transformRow(10) }] },
        ]);
        ac.totalTime = 1;
        ac.currentStateIndex = 0;
        ac.currentTime = 0.5; // irrelevant to the snapped path -- it only reads currentStateIndex

        ac.updateScene();

        const [{ bodyTransform }] = app._body.calls;
        const row = Array.isArray(bodyTransform[0]) ? bodyTransform[0] : bodyTransform;
        expect(row[0]).toBe(0); // exactly frame 0, no blending
    });
});

describe("AnimationController discrete stepping stays index-snapped under interpolation", () => {
    it("stepForward/stepBackward land exactly on a recorded frame's time, never a blended one", () => {
        const app = makeApp({ smoothInterpolation: true });
        const ac = new AnimationController(app);
        app.bodyStateWindow = { forceRedraw() {} };
        ac.playbackControls = { forceRedraw() {} };
        ac.store = fakeStore([
            { time: 0, bodies: [{ name: "a", bodyTransform: transformRow(0) }] },
            { time: 1, bodies: [{ name: "a", bodyTransform: transformRow(10) }] },
            { time: 2, bodies: [{ name: "a", bodyTransform: transformRow(20) }] },
        ]);
        ac.totalTime = 2;
        ac.currentStateIndex = 0;
        ac.currentTime = 0;

        ac.stepForward();
        expect(ac.currentStateIndex).toBe(1);
        expect(ac.currentTime).toBe(1);

        ac.stepForward();
        expect(ac.currentStateIndex).toBe(2);
        expect(ac.currentTime).toBe(2);

        ac.stepBackward();
        expect(ac.currentStateIndex).toBe(1);
        expect(ac.currentTime).toBe(1);
    });
});
