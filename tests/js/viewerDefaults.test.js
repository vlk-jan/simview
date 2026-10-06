import { describe, expect, it, vi } from "vitest";
import { mergeUiDefaults, panelHideCss } from "../../simview/static/js/utils/viewerDefaults.js";

const base = () => ({
    pointCloudsVisible: true,
    attributeVisible: { contacts: false, velocity: false },
    terrainColorMap: "magma",
});

describe("mergeUiDefaults", () => {
    it("overrides top-level and nested keys without mutating the input", () => {
        const ui = base();
        const out = mergeUiDefaults(ui, {
            pointCloudsVisible: false,
            attributeVisible: { velocity: true },
        });
        expect(out.pointCloudsVisible).toBe(false);
        expect(out.attributeVisible).toEqual({ contacts: false, velocity: true });
        expect(ui).toEqual(base());
    });

    it("ignores unknown keys with a warning", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const out = mergeUiDefaults(base(), { nope: 1, attributeVisible: { bogus: true } });
        expect(out).toEqual(base());
        expect(warn).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });

    it("returns an unchanged copy for a missing/invalid ui block", () => {
        expect(mergeUiDefaults(base(), undefined)).toEqual(base());
        expect(mergeUiDefaults(base(), [1])).toEqual(base());
    });
});

describe("panelHideCss", () => {
    it("hides only panels set to false", () => {
        const css = panelHideCss({ playback: false, legend: true });
        expect(css).toContain(".sv-playback");
        expect(css).not.toContain(".sv-legend");
    });

    it("is empty without panels", () => {
        expect(panelHideCss(undefined)).toBe("");
    });
});
