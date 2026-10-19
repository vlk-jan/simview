import { describe, expect, it } from "vitest";
import {
    NO_DATA_COLOR,
    colormapLUT,
    getCallableFromColorMapName,
} from "../../simview/static/js/objects/colormap.js";

// js-colormaps.js alert()s on any value outside [0, 1]; a blocking modal
// from a NaN terrain cell is exactly what the wrapper must never let through.
describe("getCallableFromColorMapName", () => {
    it("maps a non-finite value to the neutral no-data colour instead of alerting", () => {
        globalThis.alert = () => {
            throw new Error("alert() must not fire");
        };
        const cmap = getCallableFromColorMapName("viridis");
        for (const v of [NaN, Infinity, -Infinity]) {
            expect(cmap(v).getHex()).toBe(NO_DATA_COLOR.getHex());
        }
        delete globalThis.alert;
    });

    it("clamps finite values just outside [0, 1] to the end colours", () => {
        const cmap = getCallableFromColorMapName("viridis");
        expect(cmap(1.0000001).getHex()).toBe(cmap(1).getHex());
        expect(cmap(-0.0000001).getHex()).toBe(cmap(0).getHex());
    });
});

describe("colormapLUT", () => {
    it("tabulates the callable across [0, 1], ends exact and midpoint within a step", () => {
        const cmap = getCallableFromColorMapName("magma");
        const lut = colormapLUT(cmap, 1024);
        const at = (k) => [lut[k * 3], lut[k * 3 + 1], lut[k * 3 + 2]];
        expect(at(0)).toEqual(Array.from(new Float32Array(cmap(0).toArray())));
        expect(at(1023)).toEqual(Array.from(new Float32Array(cmap(1).toArray())));
        const mid = cmap(512 / 1023).toArray();
        at(512).forEach((v, i) => expect(v).toBeCloseTo(mid[i], 5));
    });
});
