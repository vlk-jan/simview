import { describe, expect, it } from "vitest";
import { shouldFollowLive } from "../../simview/static/js/utils/liveFollow.js";

describe("shouldFollowLive", () => {
    it("follows when there is no animation controller yet", () => {
        expect(shouldFollowLive(null)).toBe(true);
    });

    it("follows when nothing has been loaded yet (store is null)", () => {
        expect(shouldFollowLive({ store: null })).toBe(true);
    });

    it("follows when the store is empty", () => {
        expect(shouldFollowLive({ store: { length: 0 }, isPlaying: false, currentStateIndex: 0 })).toBe(true);
    });

    it("does not follow while playback is active, even if parked on the last frame", () => {
        const ac = { store: { length: 5 }, isPlaying: true, currentStateIndex: 4 };
        expect(shouldFollowLive(ac)).toBe(false);
    });

    it("follows when paused and parked exactly on the last frame", () => {
        const ac = { store: { length: 5 }, isPlaying: false, currentStateIndex: 4 };
        expect(shouldFollowLive(ac)).toBe(true);
    });

    it("does not follow when paused but scrubbed back from the last frame", () => {
        const ac = { store: { length: 5 }, isPlaying: false, currentStateIndex: 2 };
        expect(shouldFollowLive(ac)).toBe(false);
    });
});
