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

    it("getStateIndexForTime picks the nearest frame, ties going to the earlier one", () => {
        expect([-1, 0.4, 0.5, 0.6, 1.9, 3].map((t) => ac.getStateIndexForTime(t))).toEqual([
            0, 0, 0, 1, 2, 2,
        ]);
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
        ac.playbackControls = { updateElements() {} };
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

describe("AnimationController timeline that does not start at t=0", () => {
    function makeController(times) {
        const app = makeApp({ smoothInterpolation: false });
        app.bodyStateWindow = { forceRedraw() {}, animate() {} };
        const ac = new AnimationController(app);
        ac.store = fakeStore(times.map((time) => ({ time, bodies: [] })));
        ac._syncTimeline();
        ac.playbackControls = { updateElements() {}, animate() {}, recordButton: { click: () => ac.stopRecording() } };
        return ac;
    }

    it("plays through every frame instead of parking on frame 0 for firstTime seconds", () => {
        const ac = makeController([100, 101, 102, 103, 104]);
        expect(ac.firstTime).toBe(100);
        expect(ac.totalTime).toBe(4);
        ac.goToTime(0); // clamps to the first frame, not to t=0
        expect(ac.currentTime).toBe(100);
        ac.play();
        ac.lastUpdateTime = 0;
        const indices = [];
        for (let ms = 1000; ms <= 8000; ms += 1000) {
            ac.animate(ms);
            indices.push(ac.currentStateIndex);
        }
        expect(indices).toEqual([1, 2, 3, 0, 1, 2, 3, 0]);
    });

    it("goToTime clamps to [firstTime, lastTime]", () => {
        const ac = makeController([100, 101, 102]);
        ac.goToTime(500);
        expect(ac.currentTime).toBe(102);
        expect(ac.currentStateIndex).toBe(2);
    });

    it("recording stops after one loop of content regardless of playback speed", () => {
        const ac = makeController([0, 1, 2, 3, 4]); // totalTime 4 s
        ac.isRecording = true;
        ac._recordedSeconds = 0;
        ac.setSpeed(2);
        ac.play();
        ac.lastUpdateTime = 0;
        ac.animate(1000); // 2 s of content
        ac.captureFrame(1000);
        expect(ac.isRecording).toBe(true);
        ac.animate(2000); // 4 s of content: one loop
        ac.captureFrame(2000);
        expect(ac.isRecording).toBe(false);
    });

    it("setSpeed rejects non-positive and non-finite speeds", () => {
        const ac = makeController([0, 1]);
        ac.setSpeed(-1);
        ac.setSpeed(0);
        ac.setSpeed(NaN);
        expect(ac.playbackSpeed).toBe(1);
        ac.setSpeed(0.5);
        expect(ac.playbackSpeed).toBe(0.5);
    });

    it("startRecording returns false (and does not flip state) when the canvas can't be captured", () => {
        const ac = makeController([0, 1]);
        ac.app.scene = { renderer: { domElement: {} } };
        const errors = [];
        const originalError = console.error;
        console.error = (e) => errors.push(e);
        try {
            expect(ac.startRecording()).toBe(false);
        } finally {
            console.error = originalError;
        }
        expect(ac.isRecording).toBe(false);
        expect(ac.isPlaying).toBe(false);
    });

    it("onWindowLanded re-renders the current frame while paused", () => {
        const app = makeApp({ smoothInterpolation: true });
        const ac = new AnimationController(app);
        ac.store = fakeStore([
            { time: 0, bodies: [{ name: "a", bodyTransform: transformRow(0) }] },
            { time: 1, bodies: [{ name: "a", bodyTransform: transformRow(10) }] },
        ]);
        ac._syncTimeline();
        ac.currentTime = 0.5;
        ac.updateScene();
        expect(app._body.calls).toHaveLength(1);
        ac.onWindowLanded();
        expect(app._body.calls).toHaveLength(2); // memo dropped, frame re-resolved
        ac.play();
        ac.onWindowLanded();
        expect(app._body.calls).toHaveLength(2); // playing: the next tick handles it
    });
});
