# Episodes

Reinforcement-learning runs are episodic: the recording is one long timeline,
but it's really a sequence of resets. Marking those resets lets the viewer draw
episode boundaries on the playback bar, jump between episodes, and aggregate
scalars per episode instead of only over the whole run.

Mark an episode right before adding its first frame — that's what the default
`start_index` means:

```python
from simview import SimulationScene

scene = SimulationScene(batch_size=B, scalar_names=["reward"], dt=0.02)
scene.create_terrain(...)
scene.create_body(...)

for episode in range(num_episodes):
    scene.mark_episode(label=f"episode {episode}")
    obs = env.reset()
    while not done:
        ...  # step the environment
        scene.add_state(time=t, body_states=[...], scalar_values={"reward": r})

scene.save("run.json")
```

To annotate a recording you already have, pass `start_index` explicitly:

```python
scene.mark_episode(label="after reset", start_index=1500)
```

Episode starts must be strictly increasing; a repeated or out-of-order index
raises `ValueError`. Labels are optional — an unlabelled episode is shown as
"Episode N".

## In the viewer

For a scene that declares episodes, the playback bar gains:

- a tick at each episode boundary,
- **|◀** / **▶|** buttons (and the <kbd>[</kbd> / <kbd>]</kbd> keys) to jump
  between episode starts. **|◀** follows the usual media-player rule: it
  rewinds to the current episode's start first, and only steps to the previous
  episode if you're already on one,
- a label showing which episode the playhead is in.

The Scalars panel draws a dashed rule at each boundary and a horizontal line at
the focused batch's mean over each episode, and its tooltip adds that episode's
`sum` (the RL *return*) and `mean`.

None of this appears for an ordinary non-episodic scene — the controls stay
hidden entirely.

## Live streaming

`LiveViewer` has the same method, so a training run can mark resets as they
happen:

```python
with LiveViewer(scene, open_browser=True) as live:
    for episode in range(num_episodes):
        live.mark_episode(label=f"episode {episode}")
        while not done:
            live.push_state(...)
```

Connected viewers update immediately; a viewer that connects later picks the
boundaries up with the model. Like `push_state`, `mark_episode` never blocks
your loop on the network.

## Merging

Episode boundaries are indices into one specific timeline. Since
[merging](cli.md#comparing-multiple-runs-eg-real-world-vs-simulated) resamples every file onto the *first*
file's timeline, only the first file's episodes carry over — the others are
dropped with a warning, since their indices would point at the wrong frames.
