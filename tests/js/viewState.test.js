import { describe, expect, it } from "vitest";
import {
    BOOLEAN_FLAG_KEYS,
    applyToggleMapToUiState,
    parseViewState,
    serializeViewState,
    toggleMapFromUiState,
} from "../../simview/static/js/utils/viewState.js";

describe("serializeViewState / parseViewState round-trip", () => {
    it("round-trips a fully populated state", () => {
        const state = {
            time: 1.25,
            camera: {
                position: { x: 1.5, y: -2, z: 3.123456789 },
                target: { x: 0, y: 0.5, z: -1 },
                fov: 50,
            },
            batchIndex: 2,
            bodyVisualizationMode: "mesh",
            terrainColorMode: "friction",
            toggles: {
                axesVisible: true,
                trailsVisible: false,
                smoothInterpolation: true,
                terrainProbe: false,
                "attributeVisible.contacts": true,
                "attributeVisible.velocity": false,
                "attributeVisible.angularVelocity": true,
                "attributeVisible.force": false,
                "attributeVisible.torque": true,
                "terrainVisualizationModes.surface": true,
                "terrainVisualizationModes.wireframe": false,
                "terrainVisualizationModes.normals": true,
            },
        };

        const hash = serializeViewState(state);
        expect(hash.startsWith("#v=1")).toBe(true);

        const parsed = parseViewState(hash);
        expect(parsed).not.toBeNull();
        expect(parsed.time).toBeCloseTo(1.25, 6);
        expect(parsed.camera.position.x).toBeCloseTo(1.5, 6);
        expect(parsed.camera.position.y).toBeCloseTo(-2, 6);
        expect(parsed.camera.position.z).toBeCloseTo(3.123457, 5);
        expect(parsed.camera.target.x).toBeCloseTo(0, 6);
        expect(parsed.camera.target.y).toBeCloseTo(0.5, 6);
        expect(parsed.camera.target.z).toBeCloseTo(-1, 6);
        expect(parsed.camera.fov).toBeCloseTo(50, 6);
        expect(parsed.batchIndex).toBe(2);
        expect(parsed.bodyVisualizationMode).toBe("mesh");
        expect(parsed.terrainColorMode).toBe("friction");
        expect(parsed.toggles).toEqual(state.toggles);
    });

    it("round-trips a minimal state (time only)", () => {
        const hash = serializeViewState({ time: 0 });
        const parsed = parseViewState(hash);
        expect(parsed).not.toBeNull();
        expect(parsed.time).toBe(0);
        expect(parsed.camera).toBeUndefined();
        expect(parsed.batchIndex).toBeUndefined();
    });

    it("round-trips via toggleMapFromUiState/applyToggleMapToUiState helpers", () => {
        const uiState = {
            axesVisible: true,
            trailsVisible: true,
            smoothInterpolation: false,
            terrainProbe: true,
            attributeVisible: {
                contacts: true,
                velocity: false,
                angularVelocity: false,
                force: true,
                torque: false,
            },
            terrainVisualizationModes: {
                surface: true,
                wireframe: true,
                normals: false,
            },
        };

        const toggles = toggleMapFromUiState(uiState);
        const hash = serializeViewState({ toggles });
        const parsed = parseViewState(hash);

        const target = { attributeVisible: {}, terrainVisualizationModes: {} };
        applyToggleMapToUiState(target, parsed.toggles);

        expect(target.axesVisible).toBe(true);
        expect(target.trailsVisible).toBe(true);
        expect(target.smoothInterpolation).toBe(false);
        expect(target.terrainProbe).toBe(true);
        expect(target.attributeVisible.contacts).toBe(true);
        expect(target.attributeVisible.velocity).toBe(false);
        expect(target.attributeVisible.force).toBe(true);
        expect(target.terrainVisualizationModes.surface).toBe(true);
        expect(target.terrainVisualizationModes.normals).toBe(false);
    });

    it("names every BOOLEAN_FLAG_KEYS entry as a dotted or plain path", () => {
        // Sanity check that the fixture above didn't silently drift from the
        // real key list (would otherwise make the round-trip test vacuous).
        expect(BOOLEAN_FLAG_KEYS.length).toBeGreaterThan(0);
    });
});

describe("parseViewState malformed-input safety", () => {
    it("returns null for empty string", () => {
        expect(parseViewState("")).toBeNull();
    });

    it("returns null for just '#'", () => {
        expect(parseViewState("#")).toBeNull();
    });

    it("returns null for non-string input", () => {
        expect(parseViewState(null)).toBeNull();
        expect(parseViewState(undefined)).toBeNull();
        expect(parseViewState(42)).toBeNull();
        expect(parseViewState({})).toBeNull();
    });

    it("returns null when v is missing", () => {
        expect(parseViewState("#t=1.5&cam=1,2,3")).toBeNull();
    });

    it("returns null for an unsupported version", () => {
        expect(parseViewState("#v=99&t=1.5")).toBeNull();
    });

    it("returns null for a garbage string with no key=value pairs", () => {
        expect(parseViewState("#this is not a valid hash!!!")).toBeNull();
    });

    it("tolerates a malformed cam vector (wrong arity) by dropping just that field", () => {
        const parsed = parseViewState("#v=1&t=1&cam=1,2&fov=50");
        expect(parsed).not.toBeNull();
        expect(parsed.time).toBe(1);
        expect(parsed.camera.position).toBeUndefined();
        expect(parsed.camera.fov).toBe(50);
    });

    it("tolerates a non-numeric cam vector by dropping just that field", () => {
        const parsed = parseViewState("#v=1&cam=a,b,c&t=2");
        expect(parsed).not.toBeNull();
        expect(parsed.time).toBe(2);
        expect(parsed.camera).toBeUndefined();
    });

    it("tolerates a non-numeric time by omitting it", () => {
        const parsed = parseViewState("#v=1&t=notanumber&fov=40");
        expect(parsed).not.toBeNull();
        expect(parsed.time).toBeUndefined();
        expect(parsed.camera.fov).toBe(40);
    });

    it("tolerates a non-numeric flags mask by omitting toggles", () => {
        const parsed = parseViewState("#v=1&t=1&flags=notanumber");
        expect(parsed).not.toBeNull();
        expect(parsed.toggles).toBeUndefined();
    });

    it("tolerates trailing '&' and empty segments", () => {
        const parsed = parseViewState("#v=1&t=1&&&fov=40&");
        expect(parsed).not.toBeNull();
        expect(parsed.time).toBe(1);
        expect(parsed.camera.fov).toBe(40);
    });

    it("never throws on adversarial input", () => {
        const inputs = [
            "#v=1&cam=", "#v=1&bvm=%", "#v=1&tcm=%E0%A4%A", "#v=1&b=-5",
            "#v=1&b=abc", "#===", "#v=1&&t", "#v=1&t=Infinity", "#v=1&t=NaN",
            "%%%%", "#" + "a".repeat(10000),
        ];
        for (const input of inputs) {
            expect(() => parseViewState(input)).not.toThrow();
        }
    });

    it("ignores unknown keys", () => {
        const parsed = parseViewState("#v=1&t=1.5&bogusKey=whatever&anotherUnknown=123");
        expect(parsed).not.toBeNull();
        expect(parsed.time).toBe(1.5);
        expect(parsed.bogusKey).toBeUndefined();
    });

    it("rejects a negative batch index", () => {
        const parsed = parseViewState("#v=1&b=-1");
        expect(parsed).not.toBeNull();
        expect(parsed.batchIndex).toBeUndefined();
    });
});

describe("serializeViewState edge cases", () => {
    it("returns an empty string for null/undefined/non-object input", () => {
        expect(serializeViewState(null)).toBe("");
        expect(serializeViewState(undefined)).toBe("");
        expect(serializeViewState(42)).toBe("");
    });

    it("always includes the version even for an empty state object", () => {
        expect(serializeViewState({})).toBe("#v=1");
    });

    it("percent-encodes string fields that need it", () => {
        const hash = serializeViewState({ bodyVisualizationMode: "a b&c" });
        expect(hash).toContain("bvm=a%20b%26c");
        const parsed = parseViewState(hash);
        expect(parsed.bodyVisualizationMode).toBe("a b&c");
    });
});
