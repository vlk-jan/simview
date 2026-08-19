# CLI Utilities

## Cache Management

SimView caches scene files fetched from remote hosts (see [Opening a file on a remote
host](#opening-a-file-on-a-remote-host)) under `$XDG_CACHE_HOME/.simview_cache`
(`~/.cache/.simview_cache` by default). It also cleans up any `simview_viz_*.json` temp
scene files left behind by older versions (a launched viewer now serves an in-memory
`SimulationScene` directly, without writing one). You can clear all of this using the
following command:

```bash
simview clear
```

## Inspecting a scene file

To print a quick structural summary of a scene JSON file (body/terrain/state
breakdown, plus consistency warnings) without opening the viewer:

```bash
simview info scene.json          # human-readable text
simview info scene.json --json   # machine-readable JSON (for scripts/agents)
```

Works on gzip-compressed files automatically, and does not require the
`authoring` extra.

## Querying terrain data

To read raw numeric terrain values (height, and friction/stiffness if present)
at a single point or over an area, without opening the viewer:

```bash
simview terrain scene.json --point 1.5 -2.0        # bilinear-interpolated value(s) at (x, y)
simview terrain scene.json --area                  # whole terrain extent
simview terrain scene.json --area -5 5 -5 0        # xmin xmax ymin ymax sub-box
simview terrain scene.json --area --json           # machine-readable JSON (for scripts/agents)
simview terrain scene.json --area --csv            # CSV (for pandas/spreadsheets)
```

Add `--layer height|friction|stiffness` to restrict to one layer, `--batch N`
to pick a batch (only matters when the terrain isn't a singleton), and
`--stride N` to subsample an `--area` query. Like `simview info`, this works
on gzip-compressed files and doesn't require the `authoring` extra.

Pass `--batches A B` instead of `--batch N` to compare two batches directly
(e.g. a ground-truth terrain vs. a recovered friction/stiffness estimate)
instead of querying a single one — each layer then reports `value_a`,
`value_b`, and their `delta`:

```bash
simview terrain scene.json --area --batches 0 1 --json   # ground truth vs. estimate, whole extent
```

### Sampling terrain along a body's trajectory

Pass `--along-body BODY` instead of `--point`/`--area` to sample terrain
value(s) at each state's `(x, y)` position of a given body, instead of a
fixed point or area — useful for checking what terrain properties a robot
actually drove over. For example, a DRIFT-style scene with batches
`[GT, baseline, pre-adaptation, post-adaptation]`, each batch with its own
terrain and its own recorded trajectory of a body named `box`:

```bash
simview terrain scene.json --along-body box --batch 3 --json   # friction/stiffness under box's path, post-adaptation batch
```

Add `--batches A B` to compare two batches instead: both batches' terrains
are sampled **along batch A's trajectory** (batch A is the reference path,
typically ground truth), so the reported delta reflects a difference in
terrain properties under the path, not the two batches' trajectories
diverging from each other — use `simview diff` to measure that separately.

```bash
simview terrain scene.json --along-body box --batches 0 3 --json   # GT terrain vs. post-adaptation terrain, sampled along GT's path
```

`BODY` is matched the same way as `simview diff`'s `--body` (full label, or
any single name inside a rigidly-grouped body). Add `--every N` to
subsample frames.

## Comparing two batches' trajectories

To check how far apart two batches' trajectories are — e.g. ground truth vs.
a model's prediction, or baseline vs. post-adaptation — without opening the
viewer:

```bash
simview diff scene.json --batches 0 1                 # every body, human-readable text
simview diff scene.json --batches 0 1 --json           # machine-readable JSON (for scripts/agents)
simview diff scene.json --batches 0 1 --csv            # CSV, one row per (body, frame)
simview diff scene.json --batches 0 1 --body Box       # restrict to one body
```

For each body, this reports per-frame position error (meters) and
orientation error (degrees, quaternion angular distance) between the two
batches, plus mean/max/final summaries. Add `--every N` to subsample frames,
and `--pos-threshold METERS`/`--rot-threshold-deg DEGREES` to report the
first frame where a batch's trajectory diverges past a given tolerance. Like
`simview info`/`simview terrain`, this works on gzip-compressed files and
doesn't require the `authoring` extra.

Poses are compared in **world space**. A parented body's stored transform is
relative to its parent, so `simview diff` resolves the parent chain first —
the same thing the viewer's Error Metrics panel does, so the two report the
same numbers for the same scene. This also means rigidly-attached bodies (a
constant `localTransform`, never written into the states) can be diffed:
name them with `--body` like any other body.

Add `--fail-on-exceed` to make `simview diff` machine-checkable in a script
or CI job: it requires at least one of `--pos-threshold`/`--rot-threshold-deg`,
and exits non-zero if any diffed body's trajectory exceeds it (after
printing the normal output, so you still get the report either way):

```bash
simview diff scene.json --batches 0 1 --pos-threshold 0.1 --fail-on-exceed
echo $?   # 0 = within threshold, 1 = usage/parse error, 2 = threshold exceeded
```

| Exit code | Meaning |
| --- | --- |
| `0` | Every diffed body stayed within the given threshold(s). |
| `1` | Usage or parse error (bad arguments, unreadable file, etc.). |
| `2` | At least one diffed body's trajectory exceeded a threshold. |

## Visualization of exported simulations

To visualize a simulation defined in a JSON file, run the following command, replacing `[path_to_json_file]` with the actual path to your JSON data:

```bash
simview [path_to_json_file]
```

Gzip-compressed files (e.g. `scene.json.gz`) are detected automatically and decompressed
transparently — no separate flag needed.

Useful flags:

```bash
simview scene.json --host 0.0.0.0 --port 8080  # bind to a specific host/port
simview scene.json --no-browser                # don't auto-open a browser tab
simview --version                               # print the installed version
```

## Opening a file on a remote host

Anywhere the CLI takes an input file, you can give an scp-style `host:path` spec instead
of a local path, and SimView will fetch it over SSH for you:

```bash
simview rci:~/projects/DRIFT/results/comparison.json
```

`host` is passed straight to `ssh`, so `~/.ssh/config` aliases, `ProxyJump`, agent keys
and password prompts all work exactly as they do for `ssh` and `scp`. Nothing needs to
be installed on the remote — just a shell, and `gzip` if you want the transfer
compressed. `user@host:path`, `[::1]:path` and `ssh://host/path` are accepted too.

This works for every input, not just the viewer, including mixing local and remote files
in one merged scene:

```bash
simview info rci:~/results/comparison.json
simview diff rci:~/results/comparison.json --batches 0 1
simview local_rerun.json rci:~/results/real_world.json   # merged into one scene
```

**Transfers are compressed.** A plain-JSON scene is gzipped on the remote before it goes
over the wire and unpacked on arrival, which typically cuts the transfer by 5-10x on
scene data this redundant; a file that's already `*.gz` is streamed as-is. The saving is
reported when the fetch finishes:

```
Fetching rci:~/results/comparison.json (312.4MB)...
Fetched 41.2MB over the wire (312.4MB on disk, 7.6x smaller). Cached at ...
```

**Files are cached and only re-fetched when they change.** The cached copy is
byte-identical to the remote file and carries its modification time, so each run costs
one cheap `ssh` stat call to check:

```
Using cached copy of rci:~/results/comparison.json (remote unchanged).
```

Useful flags:

```bash
simview rci:~/results/scene.json --refresh   # re-fetch even if the cache is current
simview rci:~/results/scene.json --offline   # use the cache, don't contact the host
simview clear                                # drop the cache entirely
```

Remote specs are for *inputs* only — `--output` and `--save-merged` must be local paths.
A local file whose name happens to contain a colon always wins over the remote reading,
so `simview weird:name.json` still opens the file sitting next to you.

## Headless rendering (`simview render`)

To save a single PNG screenshot of a scene without opening a browser — e.g.
from a SLURM job or CI runner with no display — use `simview render`:

```bash
simview render scene.json --output frame.png
```

This starts the server in the background, drives a headless Chromium browser
via [Playwright](https://playwright.dev/), waits for the scene to load, and
saves one screenshot. It requires the optional `render` extra plus a
one-time browser download:

```bash
pip install "simview[render]"   # or: uv sync --extra render
playwright install chromium
```

Useful flags:

```bash
simview render scene.json --output frame.png --width 1920 --height 1080  # custom resolution (default 1280x720)
simview render scene.json --output frame.png --view <hash>                # restore a "Copy view link" hash first
simview render scene.json --output frame.png --host 0.0.0.0 --port 8080   # bind the background server explicitly
```

`--view` accepts the hash produced by the viewer's "Copy view link" button
(with or without the leading `#`), so a screenshot can reproduce a specific
camera angle, playback time, focused batch, and visualization toggles instead
of the viewer's default startup state.

## Comparing multiple runs (e.g. real-world vs. simulated)

Pass multiple JSON files to merge them into a single scene, each file's batches appended
as extra batches in the viewer:

```bash
simview real_world.json simulated.json
```

The files must describe the same physical setup (identical bodies and terrain grid) —
that's what makes the batches comparable. They don't need to share a timeline: the
**first** file's timestamps become the merged timeline, and every other file is
resampled onto it by nearest timestamp (no interpolation), so put the recording you
care most about matching frame-for-frame first. See [Visualization Controls](controls.md#analysis-panel)
for a way to quantify the difference between two merged batches.

Each merged file's batches are auto-named after its filename (e.g. `real_world`,
`simulated`), shown in the [Batch Legend](controls.md#batch-legend). You can rename them from
there — renames are saved next to the input file(s) and reloaded automatically the
next time you open the same file(s). You can also set initial batch names yourself by
including a `batchNames` array directly in the JSON's `model` object (see
[JSON Format Specification](../dev/json-format.md)); renames from the UI take
precedence over this once saved.

To merge files without launching the viewer, e.g. to inspect or re-share the merged
scene, pass `--save-merged`:

```bash
simview real_world.json simulated.json --save-merged combined.json.gz
```

The output is gzipped if the path ends in `.gz`.
