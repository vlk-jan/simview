# Live Streaming

Instead of saving a scene and viewing it afterwards, `LiveViewer` starts the server
immediately and pushes each state to an already-open browser tab as your simulation
produces it, over a WebSocket:

```python
from simview import LiveViewer

# `scene` needs its complete model (terrain, bodies, ...) up front; states are
# streamed in afterwards.
with LiveViewer(scene, open_browser=True) as live:
    for t in range(num_steps):
        ...  # step the simulation
        live.push_state(time=t * dt, body_states=[...], scalar_values=...)

# scene.states was appended to exactly like scene.add_state would, so it can
# still be saved once streaming is done:
scene.save("recording.json.gz", compress=True)
```

`push_state` has the same signature and validation as `SimulationScene.add_state` --
it delegates to it directly, then hands the new frame to a background sender thread that
broadcasts it to every connected viewer. A viewer opened after the stream has already
started still gets the full history so far, replayed as a catch-up before it starts
receiving new frames live. If no viewer is connected yet, pushed frames are simply
buffered for the next one to connect. Playback in the browser follows the live frames
automatically as long as you haven't scrubbed backward or started a loop; a small "LIVE"
badge shows while the socket is open.

## Backpressure

`push_state` never blocks your simulation loop on the network. Frames go into a bounded
queue (`queue_size`, 256 by default) drained by the sender thread, so a slow or hung
browser tab costs the caller nothing. When that queue fills up, the *oldest* pending
frame is dropped to make room for the newest, keeping what the viewer shows close to
live instead of falling further behind:

```python
with LiveViewer(scene, queue_size=64) as live:
    ...
print(live.dropped_frames)  # frames skipped on the wire, if any
```

Dropping only affects the live stream. Every pushed frame still lands in `scene.states`
and in the catch-up buffer, so the saved recording is complete either way. `stop()` (and
therefore the `with` block's exit) flushes whatever is still queued before shutting the
server down.

See `example_live.py` for a runnable end-to-end example.

See the [`LiveViewer` API reference](../api/live.md) for the full signature.
