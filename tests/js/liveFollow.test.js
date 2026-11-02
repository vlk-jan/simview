import { describe, expect, it } from "vitest";
import { shouldFollowLive, unseenLiveStates } from "../../simview/static/js/utils/liveFollow.js";

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

describe("unseenLiveStates", () => {
    it("passes a contiguous message through", () => {
        const states = ["a", "b"];
        expect(unseenLiveStates(states, 5, 5)).toBe(states);
    });

    it("drops a frame already received in catch-up", () => {
        expect(unseenLiveStates(["a"], 4, 5)).toEqual([]);
    });

    it("keeps only the unseen tail of a partially overlapping message", () => {
        expect(unseenLiveStates(["a", "b", "c"], 3, 5)).toEqual(["c"]);
    });

    it("accepts a message after a gap", () => {
        expect(unseenLiveStates(["a"], 8, 5)).toEqual(["a"]);
    });
});
