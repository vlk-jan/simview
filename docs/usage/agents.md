# Inspecting Scenes from Scripts and Coding Agents

A coding agent can't look at the 3D viewer, but every question it needs to ask
of a scene file has a command that prints numbers. All of them work on a
viewing-only install (no torch), on gzip-compressed files, and on remote
`host:path` specs. Each takes `--json` for strict JSON (NaN is written as
`null`); errors go to stderr, and the exit code is non-zero.

| Question | Command |
| --- | --- |
| What's in this file? Batches, bodies, terrain layers, run metadata, value ranges | `simview info F --json` |
| Where is body X at time t, how fast, is it in contact? | `simview sample F --t T --body X --json` |
| How far apart are two batches' trajectories? | `simview diff F --batches A B --json` |
| What are a terrain layer's statistics, or how do two batches' maps differ? | `simview terrain F --area [--batches A B] [--mask EXPR] --json` |
| What terrain did the robot drive over? | `simview terrain F --along-body X --json` |
| What does it look like? | `simview render F --output f.png --camera top --hide-ui` |

Batches can be named everywhere an index is accepted (`--batch GT`,
`--batches baseline post-adaptation`); a negative index counts from the end.

## Keeping output small

- `info` caps its lists at 20 entries (with `"truncated": true`); `--full` lifts the cap.
- `terrain --area` prints statistics only. The per-cell grids need `--full`,
  and with `--full`, `--json` is printed on a single line.
- `sample` takes 11 evenly spaced frames unless given `--frames` or `--t`.
  Its `--json` output is always single-line.
- `diff --json` keeps every frame. Use `--every N`, `--t0`/`--t1`, or read
  only `bodies.<name>.summary`, e.g. `simview diff F --json | jq '.bodies[].summary'`.
- `--csv` is often the most compact: one row per layer, frame or (frame, body, batch).

## Output shapes

Statistics blocks (`value_stats`) are `{count, nan_count, min, max, mean,
std, p05, p50, p95}` over finite values. `nan_count` counts NaN, infinity and
null entries.

`simview info --json`

: `file`, `model` (`batch_size`, `batch_names`, `scalar_names`, `dt`,
  `metadata`, `episodes`, `polyline_count`, `terrain` (extent, shape, bounds,
  `properties`), `bodies`, `static_objects`), `states` (`frame_count`,
  `first_time`, `last_time`, `duration`, `scalars.<name>.stats.<batch>`,
  `bodies.entries.<body>.position_bounds.<batch>.{min,max}` in world space,
  `bodies.entries.<body>.contacts.<batch>.{frames, frames_with_contact,
  mean_count, max_count}`), and `warnings`.

`simview sample --json`

: `{"batches": {label: index}, "frames": [{"frame", "time", "scalars":
  {name: {batch: value}}, "bodies": {body: {batch: {"position",
  "orientation_wxyz", "velocity"?, "angularVelocity"?, "force"?, "torque"?,
  "contact_count"?}}}}]}`. A batch label is the batch's name, or its index
  when the batch is unnamed.

`simview diff --json`

: `batch_a`, `batch_b`, `every`, `t0`, `t1`, `align_first_frame`, and
  `bodies.<body>` with the per-frame `frame_indices`, `times`,
  `position_error` (m) and `orientation_error_deg`, plus `summary`
  (`position_error`/`orientation_error_deg` mean/min/max/final/nan_count,
  and the first frame over each threshold).

`simview terrain --area --json`

: `batch`, `is_singleton`, `area` (`x_min`, `x_max`, `y_min`, `y_max`, `nx`,
  `ny`), `mask` (`expr`, `selected`, `total`, or null), and
  `stats.<layer>`. With `--batches A B` there is no `stats`; it is replaced by
  `layers.<layer>.{stats, stats_a, stats_b}`. Here `stats` describes the
  delta `b - a`: `mean_delta`, `rmse`, `mean_abs_delta`, `p95_abs_delta`,
  `max_abs_delta`, `min_abs_delta` and `count`.

## Recipe: a DRIFT adaptation window

DRIFT's adaptation scenes have four batches, `GT`, `baseline`,
`pre-adaptation` and `post-adaptation`. Each batch has its own predicted
terrain (`height`, `friction`) and a chassis body `box`. The per-window
numbers DRIFT computed are in `model.metadata` (`window`, `errors`,
`properties`, …).

```bash
S=simview_helhest_step120_triggered.json
simview info $S --json | jq '.model.metadata.errors'                   # what DRIFT recorded
simview diff $S --batches GT post-adaptation --align-first-frame --json | jq '.bodies.box.summary'
simview diff $S --batches GT baseline --align-first-frame --json | jq '.bodies.box.summary'
simview terrain $S --area --batches pre-adaptation post-adaptation --layer friction --json
simview terrain $S --along-body box --batches GT post-adaptation --layer friction
simview sample $S --frames -1 --body box                                # final poses, all batches
simview render $S --output win.png --camera top --batch post-adaptation --terrain-color friction --hide-ui
```

`--align-first-frame` matches DRIFT's `align_to_first_frame`: each trajectory
is re-expressed in its own first pose. The scene stores the chassis-centre
pose, offset from base_link, so its errors differ slightly from DRIFT's
base_link numbers.

For stitched-drive scenes (`GT`/`Sim`, with a `known` coverage layer), restrict
the terrain statistics to observed cells:

```bash
simview terrain stitch.json --area --mask "known>0.5" --batches GT Sim
```

To compare two separate files, such as the predictions of two methods
against a shared ground truth, merge them on the fly. The merge works as in
`simview view`:

```bash
simview diff compare_a.json#GT compare_b.json#Pred
```
