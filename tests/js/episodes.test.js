import { describe, expect, it } from "vitest";
import {
    episodeAggregates,
    episodeIndexAt,
    episodeLabel,
    episodeSegments,
    nextEpisodeStart,
    normalizeEpisodes,
    previousEpisodeStart,
} from "../../simview/static/js/utils/episodes.js";

const EPISODES = [
    { startIndex: 0, label: "first" },
    { startIndex: 5, label: null },
    { startIndex: 8, label: "last" },
];

describe("normalizeEpisodes", () => {
    it("sorts, dedupes and keeps only in-range integer starts", () => {
        const raw = [
            { startIndex: 5 },
            { startIndex: 0, label: "a" },
            { startIndex: 5 }, // duplicate
            { startIndex: 99 }, // past the end
            { startIndex: -1 }, // negative
            { startIndex: 2.5 }, // not an integer
            { label: "no index" },
            null,
        ];
        expect(normalizeEpisodes(raw, 10)).toEqual([
            { startIndex: 0, label: "a" },
            { startIndex: 5, label: null },
        ]);
    });

    it("returns an empty list for missing episodes or an empty timeline", () => {
        expect(normalizeEpisodes(undefined, 10)).toEqual([]);
        expect(normalizeEpisodes(null, 10)).toEqual([]);
        expect(normalizeEpisodes([{ startIndex: 0 }], 0)).toEqual([]);
    });
});

describe("episodeSegments", () => {
    it("gives each episode a half-open range up to the next start", () => {
        expect(episodeSegments(EPISODES, 12)).toEqual([
            { index: 0, label: "first", start: 0, end: 5 },
            { index: 1, label: null, start: 5, end: 8 },
            { index: 2, label: "last", start: 8, end: 12 },
        ]);
    });

    it("covers frames before the first episode with an implicit segment", () => {
        const segments = episodeSegments([{ startIndex: 3, label: "a" }], 6);
        expect(segments).toEqual([
            { index: -1, label: null, start: 0, end: 3 },
            { index: 0, label: "a", start: 3, end: 6 },
        ]);
    });

    it("treats a scene with no episodes as one implicit segment", () => {
        expect(episodeSegments([], 4)).toEqual([
            { index: -1, label: null, start: 0, end: 4 },
        ]);
    });
});

describe("episodeIndexAt", () => {
    it("finds the episode containing a frame", () => {
        expect(episodeIndexAt(EPISODES, 0)).toBe(0);
        expect(episodeIndexAt(EPISODES, 4)).toBe(0);
        expect(episodeIndexAt(EPISODES, 5)).toBe(1);
        expect(episodeIndexAt(EPISODES, 9)).toBe(2);
    });

    it("returns -1 for a frame before the first episode", () => {
        expect(episodeIndexAt([{ startIndex: 3 }], 1)).toBe(-1);
    });
});

describe("next/previousEpisodeStart", () => {
    it("advances to the following episode's start", () => {
        expect(nextEpisodeStart(EPISODES, 0)).toBe(5);
        expect(nextEpisodeStart(EPISODES, 4)).toBe(5);
        expect(nextEpisodeStart(EPISODES, 5)).toBe(8);
    });

    it("returns null past the last episode", () => {
        expect(nextEpisodeStart(EPISODES, 8)).toBe(null);
        expect(nextEpisodeStart(EPISODES, 11)).toBe(null);
    });

    it("rewinds to the current episode's start when playback has moved past it", () => {
        expect(previousEpisodeStart(EPISODES, 7)).toBe(5);
    });

    it("only steps to the previous episode when already at a start", () => {
        expect(previousEpisodeStart(EPISODES, 5)).toBe(0);
        expect(previousEpisodeStart(EPISODES, 8)).toBe(5);
    });

    it("returns null with nowhere earlier to go", () => {
        expect(previousEpisodeStart(EPISODES, 0)).toBe(null);
        expect(previousEpisodeStart([{ startIndex: 3 }], 1)).toBe(null);
    });
});

describe("episodeAggregates", () => {
    const series = Array.from({ length: 6 }, (_, i) => ({ x: i * 0.1, y: i }));

    it("aggregates each episode's slice of the series", () => {
        const aggregates = episodeAggregates(
            [
                { startIndex: 0, label: "a" },
                { startIndex: 3, label: "b" },
            ],
            series,
            6
        );

        // Episode "a" covers frames 0..2 (values 0, 1, 2).
        expect(aggregates[0]).toMatchObject({
            label: "a",
            count: 3,
            sum: 3,
            mean: 1,
            min: 0,
            max: 2,
            final: 2,
        });
        // Episode "b" covers frames 3..5 (values 3, 4, 5) -- `sum` is the
        // per-episode return an RL run cares about.
        expect(aggregates[1]).toMatchObject({
            label: "b",
            count: 3,
            sum: 12,
            mean: 4,
            final: 5,
        });
    });

    it("reports nulls rather than NaN for an empty slice", () => {
        const aggregates = episodeAggregates([{ startIndex: 0 }], [], 3);
        expect(aggregates[0]).toMatchObject({
            count: 0,
            sum: null,
            mean: null,
            min: null,
            max: null,
            final: null,
        });
    });

    it("skips non-finite values instead of poisoning the aggregate", () => {
        const withGaps = [{ y: 1 }, { y: NaN }, {}, { y: 3 }];
        const aggregates = episodeAggregates([{ startIndex: 0 }], withGaps, 4);
        expect(aggregates[0]).toMatchObject({ count: 2, sum: 4, mean: 2 });
    });
});

describe("episodeLabel", () => {
    it("prefers an explicit label", () => {
        expect(episodeLabel({ index: 0, label: "warmup" })).toBe("warmup");
    });

    it("falls back to a 1-based ordinal", () => {
        expect(episodeLabel({ index: 2, label: null })).toBe("Episode 3");
    });

    it("names the implicit pre-first-episode segment distinctly", () => {
        expect(episodeLabel({ index: -1, label: null })).toBe("(before first episode)");
    });
});
