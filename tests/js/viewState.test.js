import { describe, expect, it } from "vitest";
import {
    parseStartupOptions,
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
                polylinesVisible: false,
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

    it("round-trips toggles built by toggleMapFromUiState", () => {
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
            polylinesVisible: true,
        };

        const toggles = toggleMapFromUiState(uiState);
        const hash = serializeViewState({ toggles });
        const parsed = parseViewState(hash);

        expect(parsed.toggles).toEqual(toggles);
        expect(toggles.axesVisible).toBe(true);
        expect(toggles["attributeVisible.force"]).toBe(true);
        expect(toggles["terrainVisualizationModes.normals"]).toBe(false);
        expect(toggles.polylinesVisible).toBe(true);
        expect(parseViewState("#v=1&flags=4096").toggles.polylinesVisible).toBe(true);
    });

    it("keeps the hash format stable for existing links", () => {
        const hash = serializeViewState({
            time: 1.25,
            camera: { position: { x: 1.5, y: -2, z: 3 }, target: { x: 0, y: 0, z: 0 }, fov: 50 },
            batchIndex: 1,
            bodyVisualizationMode: "mesh",
            terrainColorMode: "height",
            toggles: { trailsVisible: true, axesVisible: true, terrainProbe: true },
        });
        expect(hash).toBe("#v=1&t=1.25&cam=1.5,-2,3&tgt=0,0,0&fov=50&b=1&bvm=mesh&tcm=height&flags=11");
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

describe("parseStartupOptions", () => {
    it("reads data, ui, play and hide with or without v=1", () => {
        expect(parseStartupOptions("#ui=0&data=/x")).toEqual({ data: "/x", ui: false, play: false, hide: [] });
        expect(parseStartupOptions("#v=1&t=2&ui=0&data=%2Fx&play=1&hide=recording,legend")).toEqual({
            data: "/x", ui: false, play: true, hide: ["recording", "legend"],
        });
    });
    it("defaults when keys are missing or input is bad", () => {
        const defaults = { data: null, ui: true, play: false, hide: [] };
        expect(parseStartupOptions("#v=1&t=2")).toEqual(defaults);
        expect(parseStartupOptions("")).toEqual(defaults);
        expect(parseStartupOptions(undefined)).toEqual(defaults);
        expect(parseStartupOptions("#ui=1&play=0")).toEqual(defaults);
    });
});

describe("named carry-over keys (pc, track, cmap, speed)", () => {
    it("round-trips all four", () => {
        const state = { pointCloudsVisible: false, trackBody: "robot 1", terrainColorMap: "viridis", playbackSpeed: 0.25 };
        const hash = serializeViewState(state);
        expect(hash).toBe("#v=1&pc=0&track=robot%201&cmap=viridis&speed=0.25");
        expect(parseViewState(hash)).toEqual(state);
    });

    it("leaves absent keys absent (absent != false)", () => {
        const parsed = parseViewState("#v=1&t=1");
        expect(parsed).not.toHaveProperty("pointCloudsVisible");
        expect(parsed).not.toHaveProperty("trackBody");
        expect(parsed).not.toHaveProperty("terrainColorMap");
        expect(parsed).not.toHaveProperty("playbackSpeed");
    });

    it("drops malformed values", () => {
        const parsed = parseViewState("#v=1&pc=yes&speed=-2&track=&cmap=");
        expect(parsed).toEqual({});
        expect(serializeViewState({ playbackSpeed: 0, pointCloudsVisible: "no" })).toBe("#v=1");
    });
});
