"""Structural summary of a scene JSON file, for `simview info` and for coding
agents inspecting simview-generated data files.

Deliberately dependency-free (stdlib only: json, gzip via
`simview.utils.read_maybe_gzipped_bytes`, base64) so it works on a base
install without the `authoring` extra (torch/einops/numpy) -- see
CLAUDE.md. Does not import `simview.model`/`simview.server`: the former
pulls in torch/einops at module scope, the latter fastapi/uvicorn just to
reach a numpy-gated helper -- both wrong layering for a lightweight
inspection tool, so the relevant constants/checks are duplicated in plain
Python below.
"""

import base64
import json
from pathlib import Path
from typing import Any

from simview.utils import read_maybe_gzipped_bytes

BLOB_PREFIX = "__b64__"

# Same fields/widths as server.py's _STATE_FIELD_WIDTHS (kept in sync
# manually, not imported -- see module docstring).
_STATE_FIELD_WIDTHS = {
    "bodyTransform": 7,
    "velocity": 3,
    "angularVelocity": 3,
    "force": 3,
    "torque": 3,
}

_MAX_DETAIL_ITEMS = 20
_LARGE_FILE_BYTES = 100_000_000


def _blob_byte_length(value: Any) -> int | None:
    """Decoded byte length if `value` is a `__b64__` blob string, else None."""
    if isinstance(value, str) and value.startswith(BLOB_PREFIX):
        return len(base64.b64decode(value[len(BLOB_PREFIX) :]))
    return None


def _encoding_of(value: Any) -> str:
    if isinstance(value, str) and value.startswith(BLOB_PREFIX):
        return "blob"
    return "plain"


def _cap(items: list, n: int = _MAX_DETAIL_ITEMS) -> tuple[list, bool]:
    return items[:n], len(items) > n


def _human_bytes(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f}{unit}" if unit != "B" else f"{int(size)}B"
        size /= 1024
    return f"{size:.1f}GB"


def _body_label(name: Any) -> str:
    return name if isinstance(name, str) else "+".join(str(n) for n in name)


def _summarize_terrain(terrain: dict) -> dict:
    dims = terrain.get("dimensions") or {}
    bounds = terrain.get("bounds") or {}
    height = terrain.get("heightData")
    normals = terrain.get("normals")
    friction = terrain.get("frictionData")
    stiffness = terrain.get("stiffnessData")
    return {
        "extent": {"x": dims.get("sizeX"), "y": dims.get("sizeY")},
        "shape": {"x": dims.get("resolutionX"), "y": dims.get("resolutionY")},
        "bounds": {
            "min_x": bounds.get("minX"),
            "max_x": bounds.get("maxX"),
            "min_y": bounds.get("minY"),
            "max_y": bounds.get("maxY"),
            "min_z": bounds.get("minZ"),
            "max_z": bounds.get("maxZ"),
        },
        "is_singleton": terrain.get("isSingleton"),
        "has_friction": friction is not None,
        "has_stiffness": stiffness is not None,
        "friction_bounds": (
            {"min": bounds.get("minFriction"), "max": bounds.get("maxFriction")}
            if friction is not None
            else None
        ),
        "stiffness_bounds": (
            {"min": bounds.get("minStiffness"), "max": bounds.get("maxStiffness")}
            if stiffness is not None
            else None
        ),
        "height_data_encoding": _encoding_of(height),
        "height_data_bytes": _blob_byte_length(height),
        "normals_encoding": _encoding_of(normals),
        "normals_bytes": _blob_byte_length(normals),
        "friction_data_encoding": _encoding_of(friction)
        if friction is not None
        else None,
        "stiffness_data_encoding": (
            _encoding_of(stiffness) if stiffness is not None else None
        ),
    }


def _summarize_model(model: dict, warnings: list[str]) -> dict:
    terrain = model.get("terrain")
    if terrain is None:
        warnings.append("model has no terrain")

    bodies = model.get("bodies") or []
    if not bodies:
        warnings.append("model defines no bodies")
    body_entries = [
        {
            "name": b.get("name"),
            "shape_type": (b.get("shape") or {}).get("type"),
            "parent": b.get("parent"),
            "has_local_transform": b.get("localTransform") is not None,
            "available_attributes": b.get("availableAttributes"),
        }
        for b in bodies
    ]
    shown_bodies, bodies_truncated = _cap(body_entries)

    static_objects = model.get("staticObjects") or []
    singleton_count = sum(1 for s in static_objects if s.get("isSingleton", True))
    so_entries = [
        {"name": s.get("name"), "is_singleton": s.get("isSingleton", True)}
        for s in static_objects
    ]
    shown_so, so_truncated = _cap(so_entries)

    return {
        "batch_size": model.get("simBatches"),
        "batch_names": model.get("batchNames"),
        "scalar_names": model.get("scalarNames") or [],
        "dt": model.get("dt"),
        "collapse": model.get("collapse"),
        "terrain": _summarize_terrain(terrain) if terrain is not None else None,
        "bodies": {
            "count": len(bodies),
            "entries": shown_bodies,
            "truncated": bodies_truncated,
            "shown": len(shown_bodies),
        },
        "static_objects": {
            "count": len(static_objects),
            "singleton_count": singleton_count,
            "batched_count": len(static_objects) - singleton_count,
            "entries": shown_so,
            "truncated": so_truncated,
            "shown": len(shown_so),
        },
    }


def _summarize_states(states: list, model: dict | None, warnings: list[str]) -> dict:
    frame_count = len(states)
    dt_from_model = model.get("dt") if model else None

    if frame_count == 0:
        warnings.append("states array is empty")
        return {
            "frame_count": 0,
            "first_time": None,
            "last_time": None,
            "duration": None,
            "dt_from_model": dt_from_model,
            "actual_mean_dt": None,
            "dt_consistent": None,
            "scalars": {},
            "bodies": {"count": 0, "entries": {}, "truncated": False, "shown": 0},
            "columnar": {"eligible": False, "reasons": ["states array is empty"]},
        }

    times = [s.get("time") for s in states]
    first_time, last_time = times[0], times[-1]
    duration = (
        last_time - first_time
        if isinstance(first_time, (int, float)) and isinstance(last_time, (int, float))
        else None
    )
    actual_mean_dt = (
        duration / (frame_count - 1)
        if duration is not None and frame_count > 1
        else None
    )
    dt_consistent = None
    if dt_from_model is not None and actual_mean_dt is not None:
        dt_consistent = abs(actual_mean_dt - dt_from_model) <= max(
            1e-6, abs(dt_from_model) * 1e-3
        )
        if not dt_consistent:
            warnings.append(
                f"model dt ({dt_from_model}) doesn't match the actual mean dt "
                f"across frames ({actual_mean_dt:.6g})"
            )

    batch_size = int((model or {}).get("simBatches") or 1)
    scalar_names = (model.get("scalarNames") or []) if model else []
    reasons: list[str] = []

    scalars_summary = {}
    for name in scalar_names:
        missing = [i for i, s in enumerate(states) if name not in s]
        for i, s in enumerate(states):
            if name not in s:
                continue
            value = s[name]
            length = len(value) if isinstance(value, list) else 1
            if length != batch_size:
                reasons.append(
                    f"scalar '{name}' in frame {i} has length {length}; "
                    f"expected {batch_size}"
                )
        shown_missing, missing_truncated = _cap(missing)
        scalars_summary[name] = {
            "present_in_all_frames": not missing,
            "missing_in_frames": shown_missing,
            "missing_truncated": missing_truncated,
        }
        if missing:
            reasons.append(f"scalar '{name}' is missing from {len(missing)} frame(s)")

    # Per-body walk, mirroring server.py's _columnarize_states structural
    # checks (field-set consistency, first-appearance-at-frame-0, no
    # dropping out) but never decoding/shaping blob values -- see module
    # docstring.
    body_order: list = []
    body_first_frame: dict = {}
    body_name_value: dict = {}
    body_fields_by_frame: dict = {}
    body_encodings_by_field: dict = {}
    body_frames_present: dict = {}
    body_contacts_frames: dict = {}

    for idx, state in enumerate(states):
        bodies = state.get("bodies") or []
        seen_keys = set()
        for body in bodies:
            if not isinstance(body, dict) or "name" not in body:
                reasons.append(f"state {idx} has a body entry missing 'name'")
                continue
            name = body["name"]
            key = tuple(name) if isinstance(name, list) else name
            if key in seen_keys:
                reasons.append(f"state {idx} lists body '{name}' more than once")
            seen_keys.add(key)

            if key not in body_order:
                body_order.append(key)
                body_first_frame[key] = idx
                body_name_value[key] = name
                body_fields_by_frame[key] = {}
                body_encodings_by_field[key] = {}
                body_frames_present[key] = []
                if idx != 0:
                    reasons.append(
                        f"body '{name}' first appears at state {idx}, not state 0"
                    )

            fields = sorted(k for k in body if k in _STATE_FIELD_WIDTHS)
            body_fields_by_frame[key][idx] = fields
            body_frames_present[key].append(idx)
            for field in fields:
                encodings = body_encodings_by_field[key].setdefault(field, set())
                encodings.add(_encoding_of(body[field]))

            if "contacts" in body:
                body_contacts_frames.setdefault(key, []).append(idx)

    bodies_summary = {}
    for key in body_order:
        name = body_name_value[key]
        label = _body_label(name)
        first_frame = body_first_frame[key]
        frames_present = body_frames_present[key]
        expected_frames = set(range(first_frame, frame_count))
        missing_frames = sorted(expected_frames - set(frames_present))
        if missing_frames:
            reasons.append(
                f"body '{name}' is missing from frame(s) {missing_frames[:5]} "
                f"after first appearing at frame {first_frame}"
            )

        per_frame_fields = body_fields_by_frame[key]
        reference_fields = per_frame_fields[first_frame]
        for idx, fields in per_frame_fields.items():
            if fields != reference_fields:
                reasons.append(
                    f"body '{name}' has inconsistent field set across frames "
                    f"(frame {idx}: {fields}, expected {reference_fields})"
                )
                break

        fields_out = {}
        for field, encodings in body_encodings_by_field[key].items():
            if len(encodings) > 1:
                encoding = "mixed"
            else:
                encoding = next(iter(encodings))
            fields_out[field] = {
                "encoding": encoding,
                "consistent_across_frames": all(
                    field in fields for fields in per_frame_fields.values()
                ),
            }

        contacts_frames = body_contacts_frames.get(key, [])
        if contacts_frames and len(contacts_frames) != len(frames_present):
            warnings.append(
                f"body '{name}' has 'contacts' in only {len(contacts_frames)}/"
                f"{len(frames_present)} of its frames (allowed; contacts are "
                "exempt from columnar packing)"
            )

        shown_missing, missing_truncated = _cap(missing_frames)
        bodies_summary[label] = {
            "first_frame": first_frame,
            "present_in_all_frames_after_first": not missing_frames,
            "missing_in_frames": shown_missing,
            "missing_truncated": missing_truncated,
            "fields": fields_out,
            "has_contacts": bool(contacts_frames),
            "contacts_frame_count": len(contacts_frames),
        }

    body_items = list(bodies_summary.items())
    shown_body_items, bodies_truncated = _cap(body_items)

    if reasons:
        warnings.append(
            f"states are not columnar-repack eligible ({len(reasons)} reason(s)); "
            "see states.columnar.reasons"
        )

    return {
        "frame_count": frame_count,
        "first_time": first_time,
        "last_time": last_time,
        "duration": duration,
        "dt_from_model": dt_from_model,
        "actual_mean_dt": actual_mean_dt,
        "dt_consistent": dt_consistent,
        "scalars": scalars_summary,
        "bodies": {
            "count": len(body_items),
            "entries": dict(shown_body_items),
            "truncated": bodies_truncated,
            "shown": len(shown_body_items),
        },
        "columnar": {"eligible": not reasons, "reasons": reasons},
    }


def summarize_scene(path: str | Path) -> dict:
    """Parse the scene JSON at `path` and return a fully structured summary
    dict. This dict IS the --json CLI output (via json.dumps); format_text()
    renders the same dict as pretty text, so the two output modes can never
    drift out of sync.

    Raises `json.JSONDecodeError` or `ValueError` on malformed input; callers
    decide how to report that (see `simview.__main__.run_info`).
    """
    path = Path(path)
    raw = path.read_bytes()
    gzipped = raw[:2] == b"\x1f\x8b"
    data = json.loads(read_maybe_gzipped_bytes(path))
    if not isinstance(data, dict):
        raise ValueError(
            "scene file must contain a JSON object with 'model'/'states' keys"
        )

    warnings: list[str] = []
    top_level_keys = sorted(data.keys())

    model_data = data.get("model")
    states_data = data.get("states")
    if model_data is None:
        warnings.append("'model' key missing from file")
    if states_data is None:
        warnings.append("'states' key missing from file")

    size_bytes = path.stat().st_size
    if size_bytes > _LARGE_FILE_BYTES:
        warnings.append(
            f"file is large ({_human_bytes(size_bytes)}); consider gzip compression"
        )

    return {
        "file": {
            "path": str(path),
            "size_bytes": size_bytes,
            "gzipped": gzipped,
            "top_level_keys": top_level_keys,
        },
        "model": _summarize_model(model_data, warnings)
        if model_data is not None
        else None,
        "states": (
            _summarize_states(states_data, model_data, warnings)
            if states_data is not None
            else None
        ),
        "warnings": warnings,
    }


def _format_table(rows: list[list[str]], headers: list[str]) -> str:
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell))
    lines = ["  " + "  ".join(h.ljust(widths[i]) for i, h in enumerate(headers))]
    for row in rows:
        lines.append("  " + "  ".join(c.ljust(widths[i]) for i, c in enumerate(row)))
    return "\n".join(lines)


def format_text(summary: dict) -> str:
    """Render `summarize_scene`'s output as a skimmable plain-text report."""
    lines = []

    f = summary["file"]
    lines.append(f"File: {f['path']}")
    lines.append(
        f"  Size: {_human_bytes(f['size_bytes'])}   Gzipped: {'yes' if f['gzipped'] else 'no'}"
    )
    lines.append(f"  Top-level keys: {', '.join(f['top_level_keys']) or '(none)'}")

    model = summary["model"]
    if model is None:
        lines.append("\nModel: (missing)")
    else:
        lines.append("\nModel")
        names = model["batch_names"]
        names_str = ", ".join(names) if names else "unnamed"
        lines.append(f"  Batches: {model['batch_size']} (names: {names_str})")
        lines.append(f"  Scalars: {', '.join(model['scalar_names']) or '(none)'}")
        lines.append(f"  dt: {model['dt']}   Collapse: {model['collapse']}")

        terrain = model["terrain"]
        if terrain is None:
            lines.append("\nTerrain: (none)")
        else:
            lines.append("\nTerrain")
            lines.append(
                f"  Extent: {terrain['extent']['x']} x {terrain['extent']['y']}"
                f"   Shape: {terrain['shape']['x']} x {terrain['shape']['y']}"
            )
            b = terrain["bounds"]
            lines.append(
                f"  Bounds: x=[{b['min_x']},{b['max_x']}] "
                f"y=[{b['min_y']},{b['max_y']}] z=[{b['min_z']},{b['max_z']}]"
            )
            friction = "yes" if terrain["has_friction"] else "no"
            stiffness = "yes" if terrain["has_stiffness"] else "no"
            lines.append(f"  Friction data: {friction}   Stiffness data: {stiffness}")
            h_bytes = terrain["height_data_bytes"]
            n_bytes = terrain["normals_bytes"]
            lines.append(
                f"  Height encoding: {terrain['height_data_encoding']}"
                f"{f' ({h_bytes} bytes)' if h_bytes is not None else ''}"
                f"   Normals encoding: {terrain['normals_encoding']}"
                f"{f' ({n_bytes} bytes)' if n_bytes is not None else ''}"
            )

        bodies = model["bodies"]
        lines.append(f"\nBodies ({bodies['count']})")
        if bodies["entries"]:
            rows = [
                [
                    e["name"] or "",
                    e["shape_type"] or "",
                    e["parent"] or "-",
                    "yes" if e["has_local_transform"] else "no",
                    ", ".join(e["available_attributes"] or []) or "-",
                ]
                for e in bodies["entries"]
            ]
            lines.append(
                _format_table(rows, ["NAME", "SHAPE", "PARENT", "LOCAL_XFORM", "ATTRS"])
            )
            if bodies["truncated"]:
                lines.append(f"  ... (+{bodies['count'] - bodies['shown']} more)")

        so = model["static_objects"]
        lines.append(
            f"\nStatic Objects ({so['count']}, {so['singleton_count']} singleton, "
            f"{so['batched_count']} batched)"
        )
        if so["truncated"]:
            lines.append(f"  ... (+{so['count'] - so['shown']} more)")

    states = summary["states"]
    if states is None:
        lines.append("\nStates: (missing)")
    else:
        lines.append(
            f"\nStates ({states['frame_count']} frames, "
            f"{states['first_time']} -> {states['last_time']}, "
            f"duration {states['duration']})"
        )
        if states["dt_from_model"] is not None:
            consistency = (
                "consistent"
                if states["dt_consistent"]
                else "INCONSISTENT"
                if states["dt_consistent"] is False
                else "n/a"
            )
            lines.append(
                f"  dt: model={states['dt_from_model']} "
                f"actual_mean={states['actual_mean_dt']} ({consistency})"
            )
        for name, scalar in states["scalars"].items():
            status = (
                "present in all frames"
                if scalar["present_in_all_frames"]
                else (f"missing from {len(scalar['missing_in_frames'])}+ frame(s)")
            )
            lines.append(f"  Scalar '{name}': {status}")

        bodies = states["bodies"]
        lines.append(f"  Bodies ({bodies['count']}):")
        for label, entry in bodies["entries"].items():
            fields_str = (
                ", ".join(
                    f"{field} ({info['encoding']}{'' if info['consistent_across_frames'] else ', inconsistent'})"
                    for field, info in entry["fields"].items()
                )
                or "(none)"
            )
            lines.append(
                f"    {label}: first frame {entry['first_frame']}, fields: {fields_str}"
            )
        if bodies["truncated"]:
            lines.append(f"    ... (+{bodies['count'] - bodies['shown']} more)")

        columnar = states["columnar"]
        lines.append(
            f"  Columnar-repack eligible: {'yes' if columnar['eligible'] else 'no'}"
        )
        if not columnar["eligible"]:
            for reason in columnar["reasons"][:_MAX_DETAIL_ITEMS]:
                lines.append(f"    - {reason}")

    lines.append("\nWarnings")
    if summary["warnings"]:
        for w in summary["warnings"]:
            lines.append(f"  - {w}")
    else:
        lines.append("  (none)")

    return "\n".join(lines)
