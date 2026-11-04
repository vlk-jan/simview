"""Per-frame state values (poses, velocities, forces, contacts, scalars) at
chosen frames or times, for `simview sample` -- the "show me the numbers"
read path for scripts and coding agents that can't look at the viewer.

Stdlib only, like `simview.diff`/`simview.terrain`, whose world-space pose
resolution it reuses (`pose_resolver`), so a parented body reports where it
actually is, not its parent-relative wire transform.
"""

import bisect

from simview.columnar import STATE_FIELD_WIDTHS, blob_floats
from simview.diff import pose_resolver
from simview.utils import (
    bodies_by_name,
    body_label,
    iter_names,
    resolve_body,
    write_csv,
)

DEFAULT_FRAME_COUNT = 11
_EXTRA_FIELDS = ("velocity", "angularVelocity", "force", "torque")


def select_frames(
    states_data: list,
    frames: str | None = None,
    times: list[float] | None = None,
    count: int = DEFAULT_FRAME_COUNT,
) -> list[int]:
    """Frame indices to sample, in order and without duplicates.

    `frames` is an index (``"5"``, ``"-1"``) or a Python slice
    (``"0:2000:100"``, ``"::50"``); `times` picks the frame nearest each time.
    With neither, `count` evenly spaced frames including the first and last.
    Raises ValueError on a malformed `frames` or non-numeric state times."""
    n = len(states_data)
    if n == 0:
        return []
    picked: list[int] = []
    if frames is not None:
        parts = frames.split(":")
        try:
            nums = [int(p) if p.strip() else None for p in parts]
        except ValueError:
            raise ValueError(
                f"frames '{frames}' must be an index or a start:stop:step slice"
            ) from None
        if len(nums) == 1:
            if nums[0] is None or not -n <= nums[0] < n:
                raise ValueError(f"frame {frames} out of range for {n} frame(s)")
            picked.append(nums[0] % n)
        elif len(nums) <= 3:
            if len(nums) == 3 and nums[2] == 0:
                raise ValueError("frames slice step must not be 0")
            picked.extend(range(n)[slice(*nums)])
        else:
            raise ValueError(f"frames '{frames}' has too many ':' parts")
    if times:
        state_times = [s.get("time") for s in states_data]
        if not all(isinstance(t, (int, float)) for t in state_times):
            raise ValueError("states have non-numeric times; use --frames instead")
        for t in times:
            i = bisect.bisect_left(state_times, t)
            candidates = [j for j in (i - 1, i) if 0 <= j < n]
            picked.append(min(candidates, key=lambda j: abs(state_times[j] - t)))
    if frames is None and not times:
        steps = max(1, min(count, n))
        picked = [round(k * (n - 1) / max(1, steps - 1)) for k in range(steps)]
    if not picked:
        raise ValueError(f"frames '{frames}' selects none of the {n} frame(s)")
    return list(dict.fromkeys(picked))


def batch_labels(model_data: dict) -> list[str]:
    """One unique display label per batch: its `batchNames` entry, or its
    index when unnamed (duplicated names get a ``#index`` suffix)."""
    size = int(model_data.get("simBatches") or 1)
    names = list(model_data.get("batchNames") or [])
    names += [None] * (size - len(names))
    labels = [str(n) if n not in (None, "") else str(i) for i, n in enumerate(names)]
    return [
        f"{lab}#{i}" if labels.count(lab) > 1 else lab for i, lab in enumerate(labels)
    ]


def _field_rows(value, width: int, batch_size: int) -> list[list[float]] | None:
    flat = blob_floats(value)
    if len(flat) != width * batch_size:
        return None
    return [flat[b * width : (b + 1) * width] for b in range(batch_size)]


def sample_states(
    model_data: dict,
    states_data: list,
    frame_indices: list[int],
    body: str | None = None,
    batches: list[int] | None = None,
) -> dict:
    """World-space pose (position + wxyz orientation) of every body (or just
    `body`), any per-body `velocity`/`angularVelocity`/`force`/`torque` as
    stored, the contact count, and every scalar, for each frame in
    `frame_indices`, for `batches` (default: all).

    Returns a JSON-serializable dict: `{"batches": {label: index}, "frames":
    [{"frame", "time", "scalars": {name: {batch_label: value}}, "bodies":
    {body_label: {batch_label: {"position", "orientation_wxyz", ...,
    "contact_count"}}}}]}`. A body without a pose in a frame is left out of
    that frame. Raises ValueError on an unknown/ambiguous `body`."""
    batch_size = int(model_data.get("simBatches") or 1)
    labels = batch_labels(model_data)
    batches = list(range(batch_size)) if batches is None else batches
    scalar_names = model_data.get("scalarNames") or []

    all_names, resolve = pose_resolver(model_data, states_data)
    targets = resolve_body(all_names, body) if all_names or body else []

    frames_out = []
    for idx in frame_indices:
        state = states_data[idx]
        raw = bodies_by_name(state.get("bodies"))
        poses = {b: resolve(state, b) for b in batches}
        scalars = {}
        for name in scalar_names:
            value = state.get(name)
            if value is None:
                continue
            per_batch = value if isinstance(value, list) else [value]
            scalars[name] = {
                labels[b]: per_batch[b] if b < len(per_batch) else None for b in batches
            }
        bodies = {}
        for name in targets:
            lookup = next(iter_names(name))
            entry = raw.get(lookup) or {}
            fields = {
                f: _field_rows(entry[f], STATE_FIELD_WIDTHS[f], batch_size)
                for f in _EXTRA_FIELDS
                if f in entry
            }
            contacts = entry.get("contacts")
            per_batch_out = {}
            for b in batches:
                row = poses[b].get(lookup)
                if row is None:
                    continue
                out: dict = {"position": row[:3], "orientation_wxyz": row[3:]}
                for f, rows in fields.items():
                    if rows is not None:
                        out[f] = rows[b]
                if isinstance(contacts, list) and b < len(contacts):
                    out["contact_count"] = len(contacts[b] or [])
                per_batch_out[labels[b]] = out
            if per_batch_out:
                bodies[body_label(name)] = per_batch_out
        frames_out.append(
            {
                "frame": idx,
                "time": state.get("time"),
                "scalars": scalars,
                "bodies": bodies,
            }
        )

    return {"batches": {labels[b]: b for b in batches}, "frames": frames_out}


def _vec(v: list[float]) -> str:
    return "[" + ", ".join(f"{x:.4g}" for x in v) + "]"


def format_sample_text(result: dict) -> str:
    """Compact per-frame text rendering of `sample_states`' output."""
    lines = [f"Batches: {', '.join(f'{k}={v}' for k, v in result['batches'].items())}"]
    for frame in result["frames"]:
        lines.append(f"\nframe {frame['frame']}  t={frame['time']}")
        for name, per_batch in frame["scalars"].items():
            values = "  ".join(
                f"{b}={f'{v:.4g}' if isinstance(v, (int, float)) else v}"
                for b, v in per_batch.items()
            )
            lines.append(f"  {name}: {values}")
        for label, per_batch in frame["bodies"].items():
            lines.append(f"  {label}:")
            for batch, out in per_batch.items():
                extras = "".join(
                    f"  {f}={_vec(out[f])}" for f in _EXTRA_FIELDS if f in out
                )
                contacts = (
                    f"  contacts={out['contact_count']}"
                    if "contact_count" in out
                    else ""
                )
                lines.append(
                    f"    {batch}: pos={_vec(out['position'])}  "
                    f"quat_wxyz={_vec(out['orientation_wxyz'])}{extras}{contacts}"
                )
    return "\n".join(lines)


def format_sample_csv(result: dict) -> str:
    """One row per (frame, body, batch); scalars as extra columns."""
    scalar_names = list(
        dict.fromkeys(n for f in result["frames"] for n in f["scalars"])
    )
    header = [
        "frame", "time", "body", "batch", "x", "y", "z", "qw", "qx", "qy", "qz",
        *(f"{f}_{a}" for f in _EXTRA_FIELDS for a in "xyz"),
        "contact_count", *scalar_names,
    ]  # fmt: skip

    def rows():
        for frame in result["frames"]:
            for label, per_batch in frame["bodies"].items():
                for batch, out in per_batch.items():
                    yield [
                        frame["frame"],
                        frame["time"],
                        label,
                        batch,
                        *out["position"],
                        *out["orientation_wxyz"],
                        *(v for f in _EXTRA_FIELDS for v in out.get(f, [None] * 3)),
                        out.get("contact_count"),
                        *(frame["scalars"].get(n, {}).get(batch) for n in scalar_names),
                    ]

    return write_csv(header, rows())
