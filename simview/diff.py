"""Trajectory divergence between two batches of one scene JSON file, for
`simview diff` and for coding agents/CI checking whether two batches (e.g.
ground truth vs. prediction, baseline vs. post-adaptation) actually track
each other.

Deliberately dependency-free (stdlib only: json, base64, struct, math via
its imports) so it works on a base install without the `authoring` extra
(torch/einops/numpy) -- see CLAUDE.md. Shares its blob-decoding and
body-resolution helpers with `simview/terrain.py`/`simview/info.py` via
`simview.columnar`/`simview.utils`, which are stdlib-only on this read path.

Output is numbers, not a rendered visualization: `compute_trajectory_diff`
returns a plain, JSON-serializable dict (full per-frame series included, no
truncation) for scripts/coding agents to consume directly, with
`format_diff_text` providing a skimmable, capped terminal rendering of the
same data.
"""

import csv
import io
import math

from simview.columnar import body_key, decode_transform_row
from simview.utils import body_label, cap, iter_names, resolve_body
from simview.utils import load_scene as load_scene  # re-exported for __main__.py

_MAX_SERIES_ROWS = 10


def _build_body_meta(model_data: dict, state_names: list) -> dict[str, dict]:
    """`name -> {"parent", "localTransform"}` for every body, from the model's
    `bodies` section. Bodies that appear in the states but not in the model are
    added as parentless roots, so a hand-edited or third-party file still
    diffs exactly as it did before parent resolution existed."""
    meta: dict[str, dict] = {}
    for entry in model_data.get("bodies") or []:
        name = entry.get("name")
        if isinstance(name, str):
            meta[name] = {
                "parent": entry.get("parent"),
                "localTransform": entry.get("localTransform"),
            }
    for name in state_names:
        for single in iter_names(name):
            meta.setdefault(single, {"parent": None, "localTransform": None})
    return meta


def _topo_sort_bodies(meta: dict[str, dict]) -> list[str]:
    """Order body names so every parent precedes its children. Independent
    stdlib port of `static/js/utils/bodyTransforms.js`'s `topoSortBodies` (see
    module docstring on why these aren't shared); each body has at most one
    parent, so a DFS post-order walk suffices."""
    order: list[str] = []
    status: dict[str, str] = {}

    def visit(name: str) -> None:
        if status.get(name) == "done":
            return
        if status.get(name) == "visiting":
            raise ValueError(f"cycle detected in body parent chain involving '{name}'")
        parent = meta[name]["parent"]
        if parent is not None:
            if parent == name:
                raise ValueError(f"body '{name}' cannot be its own parent")
            if parent not in meta:
                raise ValueError(f"body '{name}' references unknown parent '{parent}'")
            status[name] = "visiting"
            visit(parent)
        status[name] = "done"
        order.append(name)

    for name in meta:
        visit(name)
    return order


def _quat_mul(qa: list[float], qb: list[float]) -> list[float]:
    """Hamilton product of two [w, x, y, z] quaternions."""
    aw, ax, ay, az = qa
    bw, bx, by, bz = qb
    return [
        aw * bw - ax * bx - ay * by - az * bz,
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
    ]


def _rotate_vec(q: list[float], v: list[float]) -> list[float]:
    """Rotate vector `v` by [w, x, y, z] quaternion `q`."""
    w, x, y, z = q
    # t = 2 * (q_vec x v); v' = v + w * t + q_vec x t
    tx = 2 * (y * v[2] - z * v[1])
    ty = 2 * (z * v[0] - x * v[2])
    tz = 2 * (x * v[1] - y * v[0])
    return [
        v[0] + w * tx + (y * tz - z * ty),
        v[1] + w * ty + (z * tx - x * tz),
        v[2] + w * tz + (x * ty - y * tx),
    ]


def _compose(parent_row: list[float], local_row: list[float]) -> list[float]:
    """Compose a parent-relative pose onto its parent's world pose, both as
    wire rows `[x, y, z, w, qx, qy, qz]`. Same composition the viewer does in
    `bodyTransforms.js::resolveStateBodies`."""
    parent_quat, local_quat = parent_row[3:], local_row[3:]
    world_pos = _rotate_vec(parent_quat, local_row[:3])
    return [
        world_pos[0] + parent_row[0],
        world_pos[1] + parent_row[1],
        world_pos[2] + parent_row[2],
        *_quat_mul(parent_quat, local_quat),
    ]


def _expand_raw_bodies(raw_bodies: list | None) -> dict:
    """`name -> entry` for one state's `bodies`, expanding grouped (list) name
    entries so each individual body name maps to the shared entry."""
    expanded: dict = {}
    for entry in raw_bodies or []:
        name = entry.get("name")
        if name is None:
            continue
        for single in iter_names(name):
            expanded[single] = entry
    return expanded


def _resolve_frame(
    meta: dict[str, dict],
    topo_order: list[str],
    raw_by_name: dict,
    batch_size: int,
    batch_idx: int,
) -> dict[str, list[float]]:
    """`name -> absolute-world [x, y, z, w, qx, qy, qz]` for one state and one
    batch. Bodies whose pose can't be determined this frame (absent from the
    state, or with an unresolvable parent) are simply left out."""
    resolved: dict[str, list[float]] = {}
    for name in topo_order:
        body_meta = meta[name]
        raw = raw_by_name.get(name)
        raw_row = None
        if raw is not None and "bodyTransform" in raw:
            raw_row = decode_transform_row(raw["bodyTransform"], batch_size, batch_idx)

        parent = body_meta["parent"]
        if parent is None:
            # Root body: the wire transform is already absolute-world.
            if raw_row is not None:
                resolved[name] = raw_row
            continue

        parent_row = resolved.get(parent)
        if parent_row is None:
            continue
        local_transform = body_meta["localTransform"]
        if local_transform is not None:
            # Rigid attachment: a constant local offset, never sent per frame.
            local_row = [float(x) for x in local_transform]
        elif raw_row is not None:
            # Articulated attachment: the wire transform is parent-relative.
            local_row = raw_row
        else:
            continue
        resolved[name] = _compose(parent_row, local_row)
    return resolved


def _quat_angle_deg(qa: list[float], qb: list[float]) -> float:
    """Angular distance in degrees between two [w, x, y, z] quaternions,
    robust to the double-cover ambiguity (q and -q are the same rotation)."""
    dot = qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]
    dot = max(-1.0, min(1.0, abs(dot)))
    return math.degrees(2 * math.acos(dot))


def _resolve_batches(model_data: dict, batch_a: int, batch_b: int) -> int:
    batch_size = int(model_data.get("simBatches") or 1)
    if batch_size < 2:
        raise ValueError(
            f"model has only {batch_size} batch(es) (simBatches); need at "
            "least 2 to diff"
        )
    for label, b in (("batch_a", batch_a), ("batch_b", batch_b)):
        if not (0 <= b < batch_size):
            raise ValueError(f"{label}={b} out of range [0, {batch_size - 1}]")
    if batch_a == batch_b:
        raise ValueError("batch_a and batch_b must differ")
    return batch_size


def _stats(values: list[float]) -> dict:
    if not values:
        return {"mean": None, "max": None, "final": None}
    return {"mean": sum(values) / len(values), "max": max(values), "final": values[-1]}


def _first_exceeding(
    frame_indices: list[int], values: list[float], threshold: float | None
) -> int | None:
    if threshold is None:
        return None
    for frame_idx, value in zip(frame_indices, values):
        if value > threshold:
            return frame_idx
    return None


def compute_trajectory_diff(
    model_data: dict,
    states_data: list,
    batch_a: int,
    batch_b: int,
    body: str | None = None,
    every: int = 1,
    pos_threshold: float | None = None,
    rot_threshold_deg: float | None = None,
    per_axis: bool = False,
) -> dict:
    """Per-frame positional/orientation divergence between batch `batch_a`
    and batch `batch_b`'s trajectories in `states_data`, for every body
    present in the states (or just `body` if given).

    Poses are compared in **world space**: a parented body's wire transform is
    parent-relative, so the parent chain is resolved first (the same
    composition the browser's Error Metrics panel does via
    `static/js/utils/bodyTransforms.js`), and the two tools therefore report
    the same numbers for the same scene. Resolving also makes rigidly-attached
    bodies -- which carry a constant `localTransform` and never appear in the
    states -- diffable at all.

    Returns a JSON-serializable dict: `{"batch_a", "batch_b", "every",
    "pos_threshold", "rot_threshold_deg", "per_axis", "bodies": {label:
    {"frame_indices", "times", "position_error", "orientation_error_deg",
    "summary": {"frame_count", "position_error": {"mean","max","final"},
    "orientation_error_deg": {...}, "first_frame_exceeding_pos_threshold",
    "first_frame_exceeding_rot_threshold"}}}}`. When `per_axis` is set, each
    body also gets `"err_x"`/`"err_y"`/`"err_z"` per-frame series (signed
    `batch_a - batch_b`, matching the browser Error Metrics panel's
    per-axis toggle -- see `static/js/utils/errorMath.js`'s
    `positionAxisError`) and matching `"err_x"`/`"err_y"`/`"err_z"` entries
    in `summary` (mean/max/final of the *signed* value, so directional bias
    is visible). Raises `ValueError` on invalid batch indices, `every < 1`,
    an unmatched/ambiguous `body`, or a scene with no diffable bodies.
    """
    batch_size = _resolve_batches(model_data, batch_a, batch_b)
    if every < 1:
        raise ValueError(f"every must be >= 1; got {every}")

    all_names: list = []
    seen_keys = set()
    for state in states_data:
        for entry in state.get("bodies") or []:
            name = entry.get("name")
            if name is None:
                continue
            key = body_key(name)
            if key not in seen_keys:
                seen_keys.add(key)
                all_names.append(name)

    if not all_names:
        raise ValueError("no bodies found in the scene's states to diff")

    meta = _build_body_meta(model_data, all_names)
    topo_order = _topo_sort_bodies(meta)
    # Rigidly-attached children carry a constant localTransform and so never
    # appear in the states at all -- they're only diffable now that poses are
    # resolved through the parent chain.
    for name in topo_order:
        if meta[name]["localTransform"] is not None and body_key(name) not in seen_keys:
            seen_keys.add(body_key(name))
            all_names.append(name)

    target_names = resolve_body(all_names, body)

    # A grouped ("A+B") state entry shares one transform across its members, so
    # resolving the first member gives the group's pose.
    lookup_names = {body_key(name): next(iter_names(name)) for name in target_names}
    series: dict = {
        body_key(name): {
            "frame_indices": [],
            "times": [],
            "position_error": [],
            "orientation_error_deg": [],
            "err_x": [],
            "err_y": [],
            "err_z": [],
        }
        for name in target_names
    }

    for idx, state in enumerate(states_data):
        if idx % every != 0:
            continue
        raw_by_name = _expand_raw_bodies(state.get("bodies"))
        # Resolved once per frame for the whole scene rather than per body:
        # a child's world pose needs its ancestors' poses anyway.
        rows_a = _resolve_frame(meta, topo_order, raw_by_name, batch_size, batch_a)
        rows_b = _resolve_frame(meta, topo_order, raw_by_name, batch_size, batch_b)

        for name in target_names:
            key = body_key(name)
            row_a = rows_a.get(lookup_names[key])
            row_b = rows_b.get(lookup_names[key])
            if row_a is None or row_b is None:
                continue
            out = series[key]
            out["frame_indices"].append(idx)
            out["times"].append(state.get("time"))
            out["position_error"].append(math.dist(row_a[:3], row_b[:3]))
            out["orientation_error_deg"].append(_quat_angle_deg(row_a[3:], row_b[3:]))
            if per_axis:
                out["err_x"].append(row_a[0] - row_b[0])
                out["err_y"].append(row_a[1] - row_b[1])
                out["err_z"].append(row_a[2] - row_b[2])

    bodies_out = {}
    for name in target_names:
        out = series[body_key(name)]
        label = body_label(name)
        frame_indices = out["frame_indices"]
        times = out["times"]
        position_error = out["position_error"]
        orientation_error_deg = out["orientation_error_deg"]
        err_x, err_y, err_z = out["err_x"], out["err_y"], out["err_z"]

        summary = {
            "frame_count": len(frame_indices),
            "position_error": _stats(position_error),
            "orientation_error_deg": _stats(orientation_error_deg),
            "first_frame_exceeding_pos_threshold": _first_exceeding(
                frame_indices, position_error, pos_threshold
            ),
            "first_frame_exceeding_rot_threshold": _first_exceeding(
                frame_indices, orientation_error_deg, rot_threshold_deg
            ),
        }
        bodies_out[label] = {
            "frame_indices": frame_indices,
            "times": times,
            "position_error": position_error,
            "orientation_error_deg": orientation_error_deg,
            "summary": summary,
        }
        if per_axis:
            bodies_out[label]["err_x"] = err_x
            bodies_out[label]["err_y"] = err_y
            bodies_out[label]["err_z"] = err_z
            summary["err_x"] = _stats(err_x)
            summary["err_y"] = _stats(err_y)
            summary["err_z"] = _stats(err_z)

    return {
        "batch_a": batch_a,
        "batch_b": batch_b,
        "every": every,
        "pos_threshold": pos_threshold,
        "rot_threshold_deg": rot_threshold_deg,
        "per_axis": per_axis,
        "bodies": bodies_out,
    }


def format_diff_text(result: dict) -> str:
    lines = [
        f"Batches {result['batch_a']} vs {result['batch_b']}  every={result['every']}"
    ]
    if result["pos_threshold"] is not None:
        lines.append(f"  pos_threshold: {result['pos_threshold']}")
    if result["rot_threshold_deg"] is not None:
        lines.append(f"  rot_threshold_deg: {result['rot_threshold_deg']}")

    for label, body in result["bodies"].items():
        lines.append(f"\n{label}:")
        summary = body["summary"]
        if summary["frame_count"] == 0:
            lines.append(
                "  (body never present with a decodable bodyTransform in "
                "the sampled frames)"
            )
            continue

        pos, rot = summary["position_error"], summary["orientation_error_deg"]
        lines.append(
            f"  pos_err (m):   mean={pos['mean']:.6g}  max={pos['max']:.6g}  "
            f"final={pos['final']:.6g}"
        )
        lines.append(
            f"  rot_err (deg): mean={rot['mean']:.6g}  max={rot['max']:.6g}  "
            f"final={rot['final']:.6g}"
        )
        if result.get("per_axis"):
            for axis in ("err_x", "err_y", "err_z"):
                a = summary[axis]
                lines.append(
                    f"  {axis} (m):      mean={a['mean']:.6g}  max={a['max']:.6g}  "
                    f"final={a['final']:.6g}"
                )
        if summary["first_frame_exceeding_pos_threshold"] is not None:
            lines.append(
                "  first frame exceeding pos_threshold: "
                f"{summary['first_frame_exceeding_pos_threshold']}"
            )
        if summary["first_frame_exceeding_rot_threshold"] is not None:
            lines.append(
                "  first frame exceeding rot_threshold_deg: "
                f"{summary['first_frame_exceeding_rot_threshold']}"
            )

        rows = list(
            zip(
                body["frame_indices"],
                body["times"],
                body["position_error"],
                body["orientation_error_deg"],
            )
        )
        shown, truncated = cap(rows, _MAX_SERIES_ROWS)
        lines.append("  frame  time       pos_err      rot_err_deg")
        for frame_idx, t, p, r in shown:
            t_str = f"{t:.4g}" if isinstance(t, (int, float)) else str(t)
            lines.append(f"  {frame_idx:<6} {t_str:<10} {p:<12.4g} {r:<12.4g}")
        if truncated:
            lines.append(
                f"  ... (+{len(rows) - len(shown)} more frame(s); use --json "
                "for the full series)"
            )

    return "\n".join(lines)


def format_diff_csv(result: dict) -> str:
    """Render `compute_trajectory_diff`'s output as CSV: one row per
    (body, frame), full series (no truncation) -- CSV output is for scripts,
    matching the "just the numbers, in full" philosophy `--json` already
    uses everywhere in this CLI."""
    per_axis = result.get("per_axis")
    buf = io.StringIO()
    writer = csv.writer(buf)
    header = ["body", "frame", "time", "position_error", "orientation_error_deg"]
    if per_axis:
        header += ["err_x", "err_y", "err_z"]
    writer.writerow(header)
    for label, body in result["bodies"].items():
        columns = [
            body["frame_indices"],
            body["times"],
            body["position_error"],
            body["orientation_error_deg"],
        ]
        if per_axis:
            columns += [body["err_x"], body["err_y"], body["err_z"]]
        for row in zip(*columns):
            writer.writerow([label, *row])
    return buf.getvalue()
