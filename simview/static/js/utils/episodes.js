// Episode boundaries for an episodic (e.g. RL) recording -- see
// SimViewEpisode in simview/model.py and the "episodes" key in the model wire
// format. The states array is one continuous timeline; episodes only say which
// frames a run *restarts* at, so each episode implicitly ends where the next
// begins and the last runs to the end of the timeline.
//
// Pure functions, no DOM/THREE, so PlaybackControls/ScalarPlotter stay thin
// and this logic is unit-testable (tests/js/episodes.test.js).

// Cleans up whatever the model handed us: keeps only entries with a usable
// integer startIndex inside the timeline, sorts them, and drops duplicates.
// Python validates all of this on the way out, but a scene file can be
// hand-edited or produced by another tool, so don't assume.
export function normalizeEpisodes(rawEpisodes, frameCount) {
    if (!Array.isArray(rawEpisodes) || frameCount <= 0) return [];
    const seen = new Set();
    return rawEpisodes
        .map((episode) => ({
            startIndex: Number(episode?.startIndex),
            label: episode?.label ?? null,
        }))
        .filter(({ startIndex }) => Number.isInteger(startIndex))
        .filter(({ startIndex }) => startIndex >= 0 && startIndex < frameCount)
        .sort((a, b) => a.startIndex - b.startIndex)
        .filter(({ startIndex }) => {
            if (seen.has(startIndex)) return false;
            seen.add(startIndex);
            return true;
        });
}

// Expands episode starts into explicit [start, end) segments covering the
// timeline. A recording whose first episode doesn't start at frame 0 gets an
// implicit leading segment (index -1) for those frames, so every frame belongs
// to exactly one segment.
export function episodeSegments(episodes, frameCount) {
    if (frameCount <= 0) return [];
    const segments = [];
    if (episodes.length === 0 || episodes[0].startIndex > 0) {
        segments.push({
            index: -1,
            label: null,
            start: 0,
            end: episodes.length > 0 ? episodes[0].startIndex : frameCount,
        });
    }
    episodes.forEach((episode, i) => {
        segments.push({
            index: i,
            label: episode.label,
            start: episode.startIndex,
            end: i + 1 < episodes.length ? episodes[i + 1].startIndex : frameCount,
        });
    });
    return segments;
}

// Index into `episodes` of the episode containing `frameIndex`, or -1 for a
// frame before the first episode starts.
export function episodeIndexAt(episodes, frameIndex) {
    let found = -1;
    for (let i = 0; i < episodes.length; i++) {
        if (episodes[i].startIndex <= frameIndex) found = i;
        else break;
    }
    return found;
}

// Frame to jump to for "next episode": the start of the episode after the one
// containing `frameIndex`. Null when there is none (already in the last).
export function nextEpisodeStart(episodes, frameIndex) {
    for (const episode of episodes) {
        if (episode.startIndex > frameIndex) return episode.startIndex;
    }
    return null;
}

// Frame to jump to for "previous episode". Follows the familiar media-player
// rule: if playback has moved past the current episode's start, jump back to
// that start first; only if already sitting on it does it go to the previous
// episode. Null when there's nowhere earlier to go.
export function previousEpisodeStart(episodes, frameIndex) {
    const current = episodeIndexAt(episodes, frameIndex);
    if (current < 0) return null;
    if (episodes[current].startIndex < frameIndex) return episodes[current].startIndex;
    return current > 0 ? episodes[current - 1].startIndex : null;
}

// Per-episode aggregates of one scalar series, for the plotter's overlay.
// `series` is the per-batch array of {x, y} points the store hands back
// (StateStore.getScalarSeries), indexed by frame. `sum` is what an RL "return"
// is; `mean`/`min`/`max`/`final` cover the other usual questions.
export function episodeAggregates(episodes, series, frameCount) {
    return episodeSegments(episodes, frameCount).map((segment) => {
        // One pass, no spread: Math.min(...values) overflows the call stack
        // past ~125k values, i.e. any long episode.
        let count = 0;
        let sum = 0;
        let min = Infinity;
        let max = -Infinity;
        let final = null;
        for (let i = segment.start; i < segment.end && i < series.length; i++) {
            const y = series[i]?.y;
            if (!Number.isFinite(y)) continue;
            count++;
            sum += y;
            if (y < min) min = y;
            if (y > max) max = y;
            final = y;
        }
        return {
            ...segment,
            count,
            sum: count ? sum : null,
            mean: count ? sum / count : null,
            min: count ? min : null,
            max: count ? max : null,
            final,
        };
    });
}

// Live mode: episode startIndex values are absolute frame indices on the
// producer's timeline, but a viewer that connects late only has the frames
// from the catch-up window onward (the server sends each chunk's absolute
// `frameOffset`; see SimView.startLiveStream). Rebases the episodes onto the
// local store. Episodes that started before the window all collapse onto
// frame 0, so only the last of those (the one actually in progress when the
// window starts) is kept -- the earlier ones have no frames here to mark.
export function shiftEpisodes(rawEpisodes, offset) {
    if (!Array.isArray(rawEpisodes) || !(offset > 0)) return rawEpisodes;
    const before = rawEpisodes.filter((e) => Number(e?.startIndex) < offset);
    // An episode starting exactly at the window start supersedes the one
    // before it (which ended there and has no frames in this viewer).
    const atStart = rawEpisodes.some((e) => Number(e?.startIndex) === offset);
    const lastBefore = before.length && !atStart ? [before[before.length - 1]] : [];
    return [
        ...lastBefore.map((e) => ({ ...e, startIndex: 0 })),
        ...rawEpisodes
            .filter((e) => Number(e?.startIndex) >= offset)
            .map((e) => ({ ...e, startIndex: e.startIndex - offset })),
    ];
}

// Display name for an episode segment: its label if it has one, else a
// 1-based ordinal ("Episode 3"). The implicit pre-first-episode segment is
// named separately since it isn't an episode at all.
export function episodeLabel(segment) {
    if (segment.label) return segment.label;
    if (segment.index < 0) return "(before first episode)";
    return `Episode ${segment.index + 1}`;
}
