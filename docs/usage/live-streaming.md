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
it delegates to it directly, then broadcasts the new frame to every connected viewer. A
viewer opened after the stream has already started still gets the full history so far,
replayed as a single catch-up message before it starts receiving new frames live. If no
viewer is connected yet, pushed frames are simply buffered for the next one to connect.
Playback in the browser follows the live frames automatically as long as you haven't
scrubbed backward or started a loop; a small "LIVE" badge shows while the socket is open.

See `example_live.py` for a runnable end-to-end example.

See the [`LiveViewer` API reference](../api/live.md) for the full signature.
