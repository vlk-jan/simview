"""The columnar ("v4") states layout: one binary blob per body per field
covering a whole trajectory, instead of thousands of small per-frame objects.

This is both a **wire** format (served by `simview/server.py`, consumed by
`static/js/components/StateStore.js`) and, since it became first-class, an
**on-disk** format (`SimulationScene.save(columnar=True)`). The two are the
same document; only how a blob is referenced differs:

- on disk, a blob is an inline ``__b64__``-prefixed base64 string, exactly
  like the per-frame binary fields the legacy layout already used;
- over HTTP, the server rewrites each of those into a ``/blob/{token}/{id}``
  URL the browser fetches in parallel as a `Float32Array`.

That symmetry is the whole point: a columnar file needs no repacking at all
to be served, and `server.py`'s existing `extract_blobs` walker does the
rewriting for free.

Shape (see README.md "JSON Format Specification" for the authoritative spec)::

    {"version": 4,
     "times": [t0, t1, ...],                              # length T
     "bodies": [{"name": str | [str, ...],
                 "fields": {"bodyTransform": <blob>, ...},  # each (T, B, k) float32
                 "contacts": [...]}],                      # optional, length T
     "scalars": {"energy": <blob>, ...}}                   # each (T, B) float32

`columnarize_states` (numpy, writer side) and `expand_columnar_states`
(stdlib only, reader side) are inverses. Expansion is deliberately
dependency-free so the base install -- and the stdlib-only CLI tools
(`info.py`/`diff.py`/`terrain.py`) and `merge.py` -- can read columnar files
without numpy.
"""

import base64
import logging
import struct
from typing import Any

try:
    import numpy as np
except ImportError:
    np = None

logger = logging.getLogger("simview.columnar")

COLUMNAR_VERSION = 4
BLOB_PREFIX = "__b64__"

# Per-body numeric state fields eligible for columnar (whole-trajectory)
# packing, with their trailing per-batch-row width. Same fields/widths
# SimViewBodyState/add_trajectory may binary-encode per frame (state.py,
# blobCodec.js); the columnar layout just packs a whole (T, B, k) run instead
# of one (B, k) blob per frame.
STATE_FIELD_WIDTHS = {
    "bodyTransform": 7,
    "velocity": 3,
    "angularVelocity": 3,
    "force": 3,
    "torque": 3,
}


class StatesShapeMismatch(Exception):
    """Raised internally by `columnarize_states` to bail out to the legacy
    per-frame layout -- caught in one place rather than threading a bunch of
    `if inconsistent: return None` checks through the nested loops below."""


def is_columnar(states_data: Any) -> bool:
    """True if `states_data` is a columnar states document rather than the
    legacy per-frame array."""
    return (
        isinstance(states_data, dict)
        and states_data.get("version") == COLUMNAR_VERSION
    )


def inline_blob(raw: bytes) -> str:
    """`register_blob` implementation for on-disk output: keep the bytes in the
    document itself as a ``__b64__`` string (what the server instead rewrites
    into a URL)."""
    return BLOB_PREFIX + base64.b64encode(raw).decode()


def _blob_floats(value: Any) -> list[float]:
    """Decode one ``__b64__`` blob (or pass through an already-plain nested
    list, flattened) into a flat list of floats, without numpy."""
    if isinstance(value, str):
        if not value.startswith(BLOB_PREFIX):
            raise ValueError(f"expected a {BLOB_PREFIX} blob, got {value[:32]!r}")
        raw = base64.b64decode(value[len(BLOB_PREFIX) :])
        return list(struct.unpack(f"<{len(raw) // 4}f", raw))

    flat: list[float] = []

    def _flatten(x: Any) -> None:
        if isinstance(x, list):
            for item in x:
                _flatten(item)
        else:
            flat.append(float(x))

    _flatten(value)
    return flat


def _decode_state_field_rows(value, width: int, batch_size: int):
    """Decode one state's per-body field value (either a ``__b64__`` blob or a
    plain nested/flat JSON list) into a (batch_size, width) float32 array.

    Mirrors the shapes SimViewBodyState.to_json()/add_trajectory produce: a
    ``__b64__`` blob is always batch_size rows of `width` floats; a plain list
    is either already nested (one row per batch) or, for a single-batch scene,
    a flat list of `width` floats (see README "Authoring whole trajectories").
    """
    assert np is not None
    if isinstance(value, str):
        if not value.startswith(BLOB_PREFIX):
            raise StatesShapeMismatch(f"unexpected string value for field: {value!r}")
        flat = np.frombuffer(base64.b64decode(value[len(BLOB_PREFIX) :]), dtype="<f4")
    else:
        arr = np.asarray(value, dtype="<f4")
        if arr.ndim == 1:
            if batch_size != 1:
                raise StatesShapeMismatch(
                    "flat (non-nested) field value with batch size != 1"
                )
            arr = arr[None, :]
        flat = arr.reshape(-1)
    if flat.size != batch_size * width:
        raise StatesShapeMismatch(
            f"field has {flat.size} floats; expected {batch_size * width} "
            f"({batch_size} batches x {width})"
        )
    return flat.reshape(batch_size, width)


def body_key(name):
    """Hashable key for a body's `name` (a string, or a list of grouped names
    for bodies moving rigidly together -- see BodyTrajectory/SimViewBodyState).
    The original `name` value (str or list) is what actually gets emitted in
    the columnar payload; this is only used to identify "the same body slot"
    across frames."""
    return tuple(name) if isinstance(name, list) else name


def columnarize_states(states_data: list, model_data: dict | None, register_blob):
    """Repack a legacy per-frame `states` array into the columnar document, or
    return None if `states_data` doesn't meet the strict consistency
    requirements (in which case the caller keeps the legacy layout).

    `register_blob(bytes) -> str` decides how a whole-trajectory float32 blob
    is referenced: `inline_blob` for on-disk output, or the server's
    `/blob/{token}/{id}` registrar when serving over HTTP.

    Strict by design: this trades a bit of coverage (an inconsistent scene just
    doesn't get the win) for never risking a subtly wrong repack. The one
    deliberate exception is `contacts`, which may legitimately come and go per
    frame (see README) without disqualifying the rest of the scene.
    """
    if np is None or not states_data:
        return None
    if model_data is None:
        return None

    batch_size = int(model_data.get("simBatches", 1))

    try:
        times = []
        # Per body: ordered list of field names (first frame's order/set is
        # the contract every other frame must match), plus the accumulated
        # (T, B, k) rows for each field, and the original name value to emit.
        body_order: list = []
        body_fields: dict[object, list[str]] = {}
        body_name_value: dict[object, object] = {}
        body_rows: dict[object, dict[str, list]] = {}
        body_contacts: dict[object, list] = {}
        any_contacts: set = set()

        for state_idx, state in enumerate(states_data):
            if "time" not in state:
                raise StatesShapeMismatch(f"state {state_idx} is missing 'time'")
            times.append(state["time"])

            bodies = state.get("bodies") or []
            seen_keys = set()
            for body in bodies:
                if not isinstance(body, dict) or "name" not in body:
                    raise StatesShapeMismatch(
                        f"state {state_idx} has a body entry missing 'name'"
                    )
                name = body["name"]
                if not isinstance(name, (str, list)):
                    raise StatesShapeMismatch(
                        f"state {state_idx} has a non-string/list body name"
                    )
                key = body_key(name)
                if key in seen_keys:
                    raise StatesShapeMismatch(
                        f"state {state_idx} lists body '{name}' more than once"
                    )
                seen_keys.add(key)

                fields = sorted(k for k in body if k in STATE_FIELD_WIDTHS)
                if key not in body_fields:
                    if state_idx != 0 and body_rows.get(key) is None:
                        # A body appearing for the first time after frame 0
                        # would leave earlier frames' rows undefined -- bail
                        # rather than guess a fill value.
                        raise StatesShapeMismatch(
                            f"body '{name}' first appears at state {state_idx}, "
                            "not state 0"
                        )
                    body_order.append(key)
                    body_fields[key] = fields
                    body_name_value[key] = name
                    body_rows[key] = {f: [] for f in fields}
                elif body_fields[key] != fields:
                    raise StatesShapeMismatch(
                        f"body '{name}' has inconsistent field set across frames"
                    )

                for field in fields:
                    width = STATE_FIELD_WIDTHS[field]
                    rows = _decode_state_field_rows(body[field], width, batch_size)
                    body_rows[key][field].append(rows)

                if "contacts" in body:
                    any_contacts.add(key)
                    body_contacts.setdefault(key, [None] * state_idx).append(
                        body["contacts"]
                    )
                elif key in any_contacts:
                    body_contacts[key].append(None)

            missing = set(body_order) - seen_keys
            if missing:
                raise StatesShapeMismatch(
                    f"state {state_idx} is missing bodies present in earlier "
                    f"frames: {sorted(str(m) for m in missing)}"
                )
            # A body with contacts not yet seen this frame (declared later than
            # its own first appearance) still needs a None placeholder so its
            # contacts list stays length == number of frames seen so far.
            for key in any_contacts:
                lst = body_contacts[key]
                if len(lst) < state_idx + 1:
                    lst.append(None)

            scalar_names = model_data.get("scalarNames") or []
            for name in scalar_names:
                if name not in state:
                    raise StatesShapeMismatch(
                        f"state {state_idx} is missing scalar '{name}'"
                    )

        T = len(states_data)

        bodies_payload = []
        for key in body_order:
            fields_payload = {}
            for field, per_frame_rows in body_rows[key].items():
                if len(per_frame_rows) != T:
                    raise StatesShapeMismatch(
                        f"body '{body_name_value[key]}' field '{field}' is "
                        "missing from some frames"
                    )
                stacked = np.ascontiguousarray(
                    np.stack(per_frame_rows, axis=0), dtype="<f4"
                )  # (T, B, k)
                fields_payload[field] = register_blob(stacked.tobytes())
            entry = {"name": body_name_value[key], "fields": fields_payload}
            if key in any_contacts:
                entry["contacts"] = body_contacts[key]
            bodies_payload.append(entry)

        scalars_payload = {}
        for name in model_data.get("scalarNames") or []:
            per_frame = []
            for state in states_data:
                row = np.asarray(state[name], dtype="<f4")
                if row.ndim == 0:
                    row = row.reshape(1)
                if row.shape != (batch_size,):
                    raise StatesShapeMismatch(
                        f"scalar '{name}' has shape {row.shape}; expected "
                        f"({batch_size},)"
                    )
                per_frame.append(row)
            stacked = np.ascontiguousarray(np.stack(per_frame, axis=0), dtype="<f4")
            scalars_payload[name] = register_blob(stacked.tobytes())

        return {
            "version": COLUMNAR_VERSION,
            "times": times,
            "bodies": bodies_payload,
            "scalars": scalars_payload,
        }
    except StatesShapeMismatch as e:
        logger.warning(
            "States data is not columnar-repackable, keeping the legacy "
            "per-frame layout: %s",
            e,
        )
        return None


def expand_columnar_states(states_doc: dict, batch_size: int) -> list[dict]:
    """Inverse of `columnarize_states`: rebuild the legacy per-frame array.

    Stdlib only (no numpy), so every reader -- `SimulationScene.load`,
    `merge`, and the stdlib-only CLI tools -- can consume a columnar file.
    Per-body numeric fields come back out as per-frame ``__b64__`` blobs
    (byte-identical floats to what went in), so re-columnarizing a loaded
    scene reproduces the same blobs.

    Raises ValueError on a malformed/truncated document rather than emitting
    silently wrong frames.
    """
    if not is_columnar(states_doc):
        raise ValueError("not a columnar states document")

    times = states_doc.get("times")
    if not isinstance(times, list):
        raise ValueError("columnar states document has no 'times' list")
    T = len(times)
    B = max(1, int(batch_size))

    # Decode each blob once, then slice per frame.
    bodies_in = states_doc.get("bodies") or []
    decoded_bodies = []
    for body in bodies_in:
        name = body.get("name")
        if name is None:
            raise ValueError("columnar body entry is missing 'name'")
        fields = {}
        for field, blob in (body.get("fields") or {}).items():
            width = STATE_FIELD_WIDTHS.get(field)
            if width is None:
                raise ValueError(f"unknown columnar field '{field}' for body '{name}'")
            flat = _blob_floats(blob)
            expected = T * B * width
            if len(flat) != expected:
                raise ValueError(
                    f"body '{name}' field '{field}' has {len(flat)} floats; "
                    f"expected {expected} (T={T} x B={B} x {width})"
                )
            fields[field] = (flat, width)
        decoded_bodies.append((name, fields, body.get("contacts")))

    decoded_scalars = {}
    for name, blob in (states_doc.get("scalars") or {}).items():
        flat = _blob_floats(blob)
        if len(flat) != T * B:
            raise ValueError(
                f"scalar '{name}' has {len(flat)} floats; expected {T * B} "
                f"(T={T} x B={B})"
            )
        decoded_scalars[name] = flat

    states: list[dict] = []
    for t in range(T):
        body_states = []
        for name, fields, contacts in decoded_bodies:
            entry: dict = {"name": name}
            for field, (flat, width) in fields.items():
                start = t * B * width
                chunk = flat[start : start + B * width]
                entry[field] = inline_blob(struct.pack(f"<{len(chunk)}f", *chunk))
            if contacts is not None:
                value = contacts[t] if t < len(contacts) else None
                if value is not None:
                    entry["contacts"] = value
            body_states.append(entry)

        state: dict = {"time": times[t], "bodies": body_states}
        for name, flat in decoded_scalars.items():
            state[name] = flat[t * B : (t + 1) * B]
        states.append(state)

    return states
