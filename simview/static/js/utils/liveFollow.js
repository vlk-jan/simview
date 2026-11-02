// Decides whether a newly-arrived live-streaming chunk (see
// simview.live.LiveViewer / SimView.startLiveStream) should pull playback
// forward to the new last frame.
//
// Kept as a small pure function (rather than inline in SimView.processStatesChunk)
// so it can be unit-tested without instantiating a full SimView/AnimationController.
//
// True (follow) when nothing has played yet, or the viewer was parked exactly
// on the (previous) last frame and isn't mid-playback. False when the user
// scrubbed back to look at history, or is actively playing/looping -- either
// way a new chunk arriving shouldn't yank the view forward.
export function shouldFollowLive(animationController) {
    const ac = animationController;
    if (!ac || !ac.store || ac.store.length === 0) return true;
    if (ac.isPlaying) return false;
    return ac.currentStateIndex >= ac.store.length - 1;
}

// The part of a live message's `states` this viewer hasn't received yet.
// `frameOffset` is the absolute index of states[0]; `nextIndex` the absolute
// index this viewer expects next. A frame pushed while a client is between
// catch-up and broadcast registration arrives twice (once in each), so the
// already-seen prefix is dropped.
export function unseenLiveStates(states, frameOffset, nextIndex) {
    const seen = Math.max(0, nextIndex - frameOffset);
    return seen > 0 ? states.slice(seen) : states;
}
