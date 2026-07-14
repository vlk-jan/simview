import { describe, expect, it } from "vitest";
import { StateStore } from "../../simview/static/js/components/StateStore.js";

// Small hand-built fixture: T=3 frames, B=2 batches, one body "Box" with
// bodyTransform (width 7) + velocity (width 3), contacts present on frames 0
// and 2 but not frame 1, and one scalar "energy".
const T = 3;
const B = 2;

// bodyTransform rows: batch b, frame t -> [t*10+b, 0, 0, 1, 0, 0, 0]
function transformRow(t, b) {
    return [t * 10 + b, 0, 0, 1, 0, 0, 0];
}
function velocityRow(t, b) {
    return [t + b, t + b, t + b];
}

const LEGACY_STATES = [];
for (let t = 0; t < T; t++) {
    const bodies = [
        {
            name: "Box",
            bodyTransform: [transformRow(t, 0), transformRow(t, 1)],
            velocity: [velocityRow(t, 0), velocityRow(t, 1)],
        },
    ];
    if (t !== 1) {
        bodies[0].contacts = [[t], []];
    }
    LEGACY_STATES.push({
        time: t * 0.5,
        bodies,
        energy: [t * 100, t * 100 + 1],
    });
}

function buildColumnarFixture() {
    const transformFlat = new Float32Array(T * B * 7);
    const velocityFlat = new Float32Array(T * B * 3);
    for (let t = 0; t < T; t++) {
        for (let b = 0; b < B; b++) {
            transformFor(transformFlat, t, b, transformRow(t, b));
            transformFor(velocityFlat, t, b, velocityRow(t, b), 3);
        }
    }
    const energyFlat = new Float32Array(T * B);
    for (let t = 0; t < T; t++) {
        for (let b = 0; b < B; b++) {
            energyFlat[t * B + b] = t * 100 + b;
        }
    }
    const contacts = [[0], null, [2]].map((v, t) => (t === 1 ? null : [[t], []]));

    return {
        times: Array.from({ length: T }, (_, t) => t * 0.5),
        bodies: [
            {
                name: "Box",
                fields: { bodyTransform: transformFlat, velocity: velocityFlat },
                contacts,
            },
        ],
        scalars: { energy: energyFlat },
    };
}

function transformFor(flat, t, b, row, width = 7) {
    const base = (t * B + b) * width;
    for (let c = 0; c < width; c++) flat[base + c] = row[c];
}

describe("StateStore.fromLegacy", () => {
    it("exposes length/timeAt/lastTime/getFrame", () => {
        const states = LEGACY_STATES.map((s) => ({ ...s }));
        const store = StateStore.fromLegacy(states);
        expect(store.length).toBe(T);
        expect(store.timeAt(1)).toBe(0.5);
        expect(store.lastTime()).toBe(1.0);
        expect(store.getFrame(0)).toBe(states[0]);
    });

    it("append() grows length and lastTime", () => {
        const store = StateStore.fromLegacy([{ ...LEGACY_STATES[0] }]);
        expect(store.length).toBe(1);
        const startIndex = store.append([{ ...LEGACY_STATES[1] }, { ...LEGACY_STATES[2] }]);
        expect(startIndex).toBe(1);
        expect(store.length).toBe(3);
        expect(store.lastTime()).toBe(1.0);
    });
});

describe("StateStore.fromColumnar matches fromLegacy for equivalent data", () => {
    const legacyStore = StateStore.fromLegacy(
        LEGACY_STATES.map((s) => structuredClone(s))
    );
    const columnarStore = StateStore.fromColumnar(buildColumnarFixture(), B);

    it("agrees on length/times", () => {
        expect(columnarStore.length).toBe(legacyStore.length);
        expect(columnarStore.times).toEqual(legacyStore.times);
        expect(columnarStore.lastTime()).toBe(legacyStore.lastTime());
    });

    it("getFrame produces the same bodyTransform/velocity rows per frame", () => {
        for (let t = 0; t < T; t++) {
            const legacyFrame = legacyStore.getFrame(t);
            const columnarFrame = columnarStore.getFrame(t);
            expect(columnarFrame.time).toBeCloseTo(legacyFrame.time, 6);

            const legacyBody = legacyFrame.bodies[0];
            const columnarBody = columnarFrame.bodies[0];
            expect(columnarBody.name).toBe(legacyBody.name);
            expect(columnarBody.bodyTransform).toEqual(legacyBody.bodyTransform);
            expect(columnarBody.velocity).toEqual(legacyBody.velocity);
        }
    });

    it("getFrame preserves null contacts for the frame missing them", () => {
        const legacyFrame1 = legacyStore.getFrame(1);
        const columnarFrame1 = columnarStore.getFrame(1);
        expect(legacyFrame1.bodies[0].contacts).toBeUndefined();
        expect(columnarFrame1.bodies[0].contacts).toBeNull();

        const legacyFrame0 = legacyStore.getFrame(0);
        const columnarFrame0 = columnarStore.getFrame(0);
        expect(columnarFrame0.bodies[0].contacts).toEqual(legacyFrame0.bodies[0].contacts);
    });

    it("getScalarSeries matches between legacy and columnar", () => {
        const legacySeries = legacyStore.getScalarSeries("energy", B);
        const columnarSeries = columnarStore.getScalarSeries("energy", B);
        expect(columnarSeries).toEqual(legacySeries);
    });
});

describe("StateStore.fromColumnar getFrame memoization", () => {
    it("returns a fresh object per distinct frame index but is stable within the same index", () => {
        const store = StateStore.fromColumnar(buildColumnarFixture(), B);
        const frame0a = store.getFrame(0);
        const frame0b = store.getFrame(0);
        expect(frame0a).toBe(frame0b);

        const frame1 = store.getFrame(1);
        expect(frame1).not.toBe(frame0a);
        expect(frame1.time).toBeCloseTo(0.5, 6);
    });
});
