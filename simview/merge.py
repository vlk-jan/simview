"""Merge multiple SimView JSON simulation files into a single multi-batch scene.

Each input file contributes its `simBatches` as extra batches in the output
(e.g. a single-batch real-world recording plus a single-batch simulated rerun
become a 2-batch scene, viewable and comparable side by side). All files must
describe the same physical setup -- identical bodies and terrain grid -- since
that's what makes the batches comparable.

Files are not required to share a timeline: the first file's timestamps become
the merged timeline, and every other file is resampled onto it by nearest
timestamp (zero-order hold, no interpolation). Put the recording you care most
about matching frame-for-frame first.
"""

import base64
import bisect
import json
import logging
import struct
from pathlib import Path

try:
    import orjson
except ImportError:
    orjson = None

from .utils import read_maybe_gzipped_bytes

logger = logging.getLogger("simview.merge")

_OPTIONAL_VECTOR_ATTRS = ["velocity", "angularVelocity", "force", "torque"]

# Trailing width of each binary per-body state field, used to reshape a decoded
# flat float32 buffer back into per-batch rows.
_STATE_FIELD_WIDTHS = {
    "bodyTransform": 7,
    "velocity": 3,
    "angularVelocity": 3,
    "force": 3,
    "torque": 3,
}


def _decode_state_field(value, width: int):
    """Expand a binary ``__b64__`` per-body state field to a list of per-batch
    rows. Plain lists pass through unchanged, so merged output is always JSON
    lists regardless of whether inputs used binary encoding. Kept dependency-free
    (no numpy/torch) so it works in viewing-only installs."""
    if not (isinstance(value, str) and value.startswith("__b64__")):
        return value
    raw = base64.b64decode(value[7:])
    flat = struct.unpack(f"<{len(raw) // 4}f", raw)
    return [list(flat[i : i + width]) for i in range(0, len(flat), width)]


def _decode_per_batch(value: list | str, batch_size: int) -> list:
    """Normalize a terrain data field (heightData/normals/frictionData/
    stiffnessData) to a plain list of length `batch_size`, one entry per
    batch, regardless of whether it's a binary ``__b64__`` blob (one flat
    buffer covering all batches) or an already-batched plain list. Used so
    that inputs mixing binary and plain-list encoding can still be
    concatenated -- each file's field is decoded independently rather than
    branching on a single file's encoding."""
    if not (isinstance(value, str) and value.startswith("__b64__")):
        return value
    raw = base64.b64decode(value[7:])
    flat = struct.unpack(f"<{len(raw) // 4}f", raw)
    width = len(flat) // batch_size
    return [list(flat[i : i + width]) for i in range(0, len(flat), width)]


def _load_json(path: Path) -> dict:
    raw = read_maybe_gzipped_bytes(path)
    return orjson.loads(raw) if orjson else json.loads(raw)


def _require(doc, key: str, expected_type: type | tuple[type, ...], label: str):
    """Look up a dotted `key` (e.g. "model.terrain.bounds") in `doc`, raising a
    clear ValueError naming `label` and the offending key if it's missing or
    has the wrong type. Returns the value on success."""
    node = doc
    parts = key.split(".")
    for i, part in enumerate(parts):
        if not isinstance(node, dict) or part not in node:
            raise ValueError(
                f"File '{label}' is missing '{key}' -- is it a valid SimView scene?"
            )
        node = node[part]
        is_last = i == len(parts) - 1
        if is_last and not isinstance(node, expected_type):
            type_names = (
                expected_type.__name__
                if isinstance(expected_type, type)
                else " or ".join(t.__name__ for t in expected_type)
            )
            raise ValueError(
                f"File '{label}' has '{key}' of type {type(node).__name__}; "
                f"expected {type_names} -- is it a valid SimView scene?"
            )
    return node


def _validate_doc(doc: dict, label: str) -> None:
    """Lightweight upfront structural check for a loaded SimView JSON document,
    so malformed input fails fast with a clear message instead of a deep
    KeyError once the merge logic starts walking nested fields."""
    if not isinstance(doc, dict):
        raise ValueError(
            f"File '{label}' does not contain a JSON object at the top level "
            "-- is it a valid SimView scene?"
        )
    _require(doc, "model", dict, label)
    _require(doc, "model.bodies", list, label)
    for idx, body in enumerate(doc["model"]["bodies"]):
        if not isinstance(body, dict) or "name" not in body:
            raise ValueError(
                f"File '{label}' has 'model.bodies[{idx}]' missing 'name' -- "
                "is it a valid SimView scene?"
            )
    _require(doc, "model.terrain", dict, label)
    _require(doc, "model.terrain.dimensions", dict, label)
    _require(doc, "model.terrain.bounds", dict, label)
    _require(doc, "model.terrain.heightData", (list, str), label)
    _require(doc, "model.terrain.normals", (list, str), label)
    _require(doc, "states", list, label)
    if not doc["states"]:
        raise ValueError(f"'{label}' has no states")
    for idx, state in enumerate(doc["states"]):
        if not isinstance(state, dict) or "time" not in state:
            raise ValueError(
                f"File '{label}' has 'states[{idx}]' missing 'time' -- is it "
                "a valid SimView scene?"
            )


def _expand_batched(
    values: list | str, is_singleton: bool, batch_size: int, field: str, label: str
) -> list | str:
    # A __b64__ blob's decoded length is always taken to span batch_size rows
    # (see _decode_per_batch, and Terrain.js's identical convention on the
    # viewer side) regardless of isSingleton. Singleton data is nominally a
    # single shared entry, but the only producer that ever sets isSingleton on
    # terrain (SimViewModel.create_terrain) already broadcasts it out to
    # batch_size rows before encoding, so the blob is never a lone unbroadcast
    # row that needs expanding here -- doing so would double it to
    # batch_size^2 rows. Leave b64 blobs untouched; only plain lists (where the
    # row count is directly observable) may need broadcasting below.
    if isinstance(values, str) and values.startswith("__b64__"):
        return values

    if len(values) == batch_size:
        return values
    if is_singleton and len(values) == 1:
        return list(values) * batch_size
    raise ValueError(
        f"'{label}': '{field}' has {len(values)} entries; expected 1 (singleton) "
        f"or {batch_size} (simBatches)."
    )


def _normalize_per_batch(value: list, batch_size: int) -> list:
    """Normalize a body-state vector field that may be a flat single-batch
    vector or an already-batched list of vectors into a list of length
    batch_size."""
    if batch_size == 1 and value and not isinstance(value[0], list):
        return [value]
    return value


def _merge_bodies(models: list[dict], labels: list[str]) -> list[dict]:
    bodies = models[0].get("bodies", [])
    for model, label in zip(models[1:], labels[1:]):
        if model.get("bodies", []) != bodies:
            raise ValueError(
                f"'{label}' defines different bodies than '{labels[0]}'. All merged "
                "files must describe identical bodies (name, shape, availableAttributes) "
                "for batches to be comparable."
            )
    return bodies


def _default_batch_names(paths: list[Path], batch_sizes: list[int]) -> list[str]:
    """One name per output batch, derived from the source file it came from.
    Single-batch files just use the file stem; multi-batch files get an index
    suffix so batches from the same file are still distinguishable."""
    names = []
    for path, batch_size in zip(paths, batch_sizes):
        stem = path.stem
        if batch_size == 1:
            names.append(stem)
        else:
            names.extend(f"{stem}[{j}]" for j in range(batch_size))
    return names


def _merge_scalar_names(models: list[dict], labels: list[str]) -> list[str]:
    names = models[0].get("scalarNames") or []
    name_set = set(names)
    for model, label in zip(models[1:], labels[1:]):
        other = set(model.get("scalarNames") or [])
        if other != name_set:
            raise ValueError(
                f"'{label}' has scalarNames {sorted(other)}, expected {sorted(name_set)} "
                f"(from '{labels[0]}'). All merged files must define the same scalars."
            )
    return names


def _merge_static_objects(
    models: list[dict], batch_sizes: list[int], labels: list[str]
) -> list[dict]:
    first = models[0].get("staticObjects") or []
    names = [s["name"] for s in first]
    for model, label in zip(models[1:], labels[1:]):
        other_names = [s["name"] for s in (model.get("staticObjects") or [])]
        if other_names != names:
            raise ValueError(
                f"'{label}' defines different static objects than '{labels[0]}'."
            )

    merged = []
    for idx, name in enumerate(names):
        is_singleton = first[idx]["isSingleton"]
        entry = {"name": name, "isSingleton": is_singleton}
        if is_singleton:
            shape = first[idx]["shape"]
            for model, label in zip(models[1:], labels[1:]):
                if model["staticObjects"][idx]["shape"] != shape:
                    raise ValueError(
                        f"Singleton static object '{name}' differs between "
                        f"'{labels[0]}' and '{label}'."
                    )
            entry["shape"] = shape
        else:
            shapes = []
            for model, batch_size, label in zip(models, batch_sizes, labels):
                shapes.extend(
                    _expand_batched(
                        model["staticObjects"][idx]["shapes"],
                        False,
                        batch_size,
                        "shapes",
                        label,
                    )
                )
            entry["shapes"] = shapes
        merged.append(entry)
    return merged


def _merge_terrain(
    models: list[dict], batch_sizes: list[int], labels: list[str]
) -> dict:
    first_terrain = models[0]["terrain"]
    dims = first_terrain["dimensions"]
    for model, label in zip(models[1:], labels[1:]):
        other_dims = model["terrain"]["dimensions"]
        if other_dims != dims:
            raise ValueError(
                f"'{label}' terrain dimensions {other_dims} do not match "
                f"'{labels[0]}' dimensions {dims}."
            )

    has_friction = all(
        model["terrain"].get("frictionData") is not None for model in models
    )
    has_stiffness = all(
        model["terrain"].get("stiffnessData") is not None for model in models
    )
    if not has_friction and any(
        model["terrain"].get("frictionData") is not None for model in models
    ):
        logger.warning(
            "Not all files provide terrain friction data; dropping "
            "frictionData from the merged terrain."
        )
    if not has_stiffness and any(
        model["terrain"].get("stiffnessData") is not None for model in models
    ):
        logger.warning(
            "Not all files provide terrain stiffness data; dropping "
            "stiffnessData from the merged terrain."
        )

    def _concat_lists_or_b64(items: list[tuple]) -> list | None:
        # Each item is decoded independently, keyed by its own batch_size (not
        # branched on items[0]'s encoding), so a mix of binary and plain-list
        # inputs merges correctly instead of crashing -- or silently
        # corrupting shapes -- on a differently-encoded item.
        if not items:
            return None
        merged = []
        for value, batch_size in items:
            merged.extend(_decode_per_batch(value, batch_size))
        return merged

    height_data, normals, friction_data, stiffness_data = [], [], [], []
    min_z = max_z = None
    min_friction = max_friction = min_stiffness = max_stiffness = None
    for model, batch_size, label in zip(models, batch_sizes, labels):
        terrain = model["terrain"]
        singleton = terrain.get("isSingleton", False)
        height_data.append(
            (
                _expand_batched(
                    terrain["heightData"], singleton, batch_size, "heightData", label
                ),
                batch_size,
            )
        )
        normals.append(
            (
                _expand_batched(
                    terrain["normals"], singleton, batch_size, "normals", label
                ),
                batch_size,
            )
        )

        bounds = terrain["bounds"]
        min_z = bounds["minZ"] if min_z is None else min(min_z, bounds["minZ"])
        max_z = bounds["maxZ"] if max_z is None else max(max_z, bounds["maxZ"])
        if has_friction:
            friction_data.append(
                (
                    _expand_batched(
                        terrain["frictionData"],
                        singleton,
                        batch_size,
                        "frictionData",
                        label,
                    ),
                    batch_size,
                )
            )
            min_friction = (
                bounds["minFriction"]
                if min_friction is None
                else min(min_friction, bounds["minFriction"])
            )
            max_friction = (
                bounds["maxFriction"]
                if max_friction is None
                else max(max_friction, bounds["maxFriction"])
            )
        if has_stiffness:
            stiffness_data.append(
                (
                    _expand_batched(
                        terrain["stiffnessData"],
                        singleton,
                        batch_size,
                        "stiffnessData",
                        label,
                    ),
                    batch_size,
                )
            )
            min_stiffness = (
                bounds["minStiffness"]
                if min_stiffness is None
                else min(min_stiffness, bounds["minStiffness"])
            )
            max_stiffness = (
                bounds["maxStiffness"]
                if max_stiffness is None
                else max(max_stiffness, bounds["maxStiffness"])
            )

    merged_bounds = {
        "minX": first_terrain["bounds"]["minX"],
        "maxX": first_terrain["bounds"]["maxX"],
        "minY": first_terrain["bounds"]["minY"],
        "maxY": first_terrain["bounds"]["maxY"],
        "minZ": min_z,
        "maxZ": max_z,
    }
    if has_friction:
        merged_bounds["minFriction"] = min_friction
        merged_bounds["maxFriction"] = max_friction
    if has_stiffness:
        merged_bounds["minStiffness"] = min_stiffness
        merged_bounds["maxStiffness"] = max_stiffness

    return {
        "dimensions": dims,
        "bounds": merged_bounds,
        "isSingleton": False,
        "heightData": _concat_lists_or_b64(height_data),
        "normals": _concat_lists_or_b64(normals),
        "frictionData": _concat_lists_or_b64(friction_data) if has_friction else None,
        "stiffnessData": _concat_lists_or_b64(stiffness_data)
        if has_stiffness
        else None,
    }


def _nearest_index(sorted_times: list[float], t: float) -> int:
    i = bisect.bisect_left(sorted_times, t)
    if i == 0:
        return 0
    if i >= len(sorted_times):
        return len(sorted_times) - 1
    before, after = sorted_times[i - 1], sorted_times[i]
    return i - 1 if (t - before) <= (after - t) else i


def _state_body_lookup(
    states: list[dict], file_idx: int, state_idx: int, cache: dict
) -> dict[str, dict]:
    key = (file_idx, state_idx)
    lookup = cache.get(key)
    if lookup is None:
        lookup = {}
        for b in states[state_idx].get("bodies", []):
            name = b["name"]
            # `name` may be a list of body names sharing one transform (see
            # SimulationScene.add_state/add_trajectory); index each under its
            # own key so per-body lookups below don't need to know about it.
            for n in name if isinstance(name, list) else [name]:
                lookup[n] = b
        cache[key] = lookup
    return lookup


def _merge_states(
    states_list: list[list[dict]],
    batch_sizes: list[int],
    bodies: list[dict],
    scalar_names: list[str],
    labels: list[str],
) -> list[dict]:
    ref_times = [s["time"] for s in states_list[0]]
    times_by_file = [[s["time"] for s in states] for states in states_list]
    total_batches = sum(batch_sizes)
    lookup_cache: dict = {}

    merged_states = []
    for out_idx, t in enumerate(ref_times):
        state_idx_by_file = [
            out_idx if file_idx == 0 else _nearest_index(times_by_file[file_idx], t)
            for file_idx in range(len(states_list))
        ]

        merged_bodies = []
        for body in bodies:
            name = body["name"]
            available = set(body.get("availableAttributes") or [])
            transform = []
            attr_values = {
                attr: [] for attr in _OPTIONAL_VECTOR_ATTRS if attr in available
            }
            contacts = [] if "contacts" in available else None

            for file_idx, (states, batch_size) in enumerate(
                zip(states_list, batch_sizes)
            ):
                state_idx = state_idx_by_file[file_idx]
                lookup = _state_body_lookup(states, file_idx, state_idx, lookup_cache)
                body_state = lookup.get(name)
                if body_state is None:
                    raise ValueError(
                        f"'{labels[file_idx]}' is missing body '{name}' at "
                        f"t={states[state_idx]['time']}."
                    )
                transform.extend(
                    _normalize_per_batch(
                        _decode_state_field(
                            body_state["bodyTransform"],
                            _STATE_FIELD_WIDTHS["bodyTransform"],
                        ),
                        batch_size,
                    )
                )
                for attr in attr_values:
                    if attr not in body_state:
                        raise ValueError(
                            f"'{labels[file_idx]}' body '{name}' declares '{attr}' as "
                            f"available but is missing it at t={states[state_idx]['time']}."
                        )
                    attr_values[attr].extend(
                        _normalize_per_batch(
                            _decode_state_field(
                                body_state[attr], _STATE_FIELD_WIDTHS[attr]
                            ),
                            batch_size,
                        )
                    )
                if contacts is not None:
                    if "contacts" not in body_state:
                        raise ValueError(
                            f"'{labels[file_idx]}' body '{name}' declares 'contacts' as "
                            f"available but is missing it at t={states[state_idx]['time']}."
                        )
                    contacts.extend(body_state["contacts"])

            if len(transform) != total_batches:
                raise ValueError(
                    f"Merged 'bodyTransform' for body '{name}' has {len(transform)} "
                    f"rows; expected {total_batches} (sum of simBatches across "
                    f"{', '.join(repr(label) for label in labels)}). Check that "
                    "each file's per-body state rows match its declared simBatches."
                )
            merged_body = {"name": name, "bodyTransform": transform, **attr_values}
            if contacts is not None:
                merged_body["contacts"] = contacts
            merged_bodies.append(merged_body)

        merged_state = {"time": t, "bodies": merged_bodies}
        for scalar_name in scalar_names:
            values = []
            for file_idx, (states, batch_size) in enumerate(
                zip(states_list, batch_sizes)
            ):
                state_idx = state_idx_by_file[file_idx]
                scalar_values = states[state_idx].get(scalar_name)
                if scalar_values is None:
                    raise ValueError(
                        f"'{labels[file_idx]}' is missing scalar '{scalar_name}' at "
                        f"t={states[state_idx]['time']}."
                    )
                values.extend(scalar_values)
            merged_state[scalar_name] = values
        merged_states.append(merged_state)

    return merged_states


def merge_simulation_files(paths: list[str | Path]) -> dict:
    """Load and merge `paths` into a single `{"model": ..., "states": ...}` dict
    where each file's batches are concatenated into the output's batch dimension."""
    if len(paths) < 2:
        raise ValueError("merge_simulation_files requires at least 2 files")

    paths = [Path(p) for p in paths]
    labels = [p.name for p in paths]
    docs = [_load_json(p) for p in paths]
    for doc, label in zip(docs, labels):
        _validate_doc(doc, label)
    models = [doc["model"] for doc in docs]
    states_list = [doc["states"] for doc in docs]
    batch_sizes = [int(m.get("simBatches", 1)) for m in models]

    bodies = _merge_bodies(models, labels)
    scalar_names = _merge_scalar_names(models, labels)
    static_objects = _merge_static_objects(models, batch_sizes, labels)
    terrain = _merge_terrain(models, batch_sizes, labels)
    merged_states = _merge_states(
        states_list, batch_sizes, bodies, scalar_names, labels
    )

    total_batches = sum(batch_sizes)
    offsets = [sum(batch_sizes[:i]) for i in range(len(batch_sizes))]
    ranges = ", ".join(
        f"'{label}' -> batches {offset}-{offset + size - 1}"
        for label, offset, size in zip(labels, offsets, batch_sizes)
    )
    logger.info(
        "Merged %d files into %d batches (%s)", len(paths), total_batches, ranges
    )

    merged_model = {
        "simBatches": total_batches,
        "batchNames": _default_batch_names(paths, batch_sizes),
        "scalarNames": scalar_names,
        "dt": models[0].get("dt"),
        "collapse": models[0].get("collapse", False),
        "terrain": terrain,
        "bodies": bodies,
        "staticObjects": static_objects,
    }
    return {"model": merged_model, "states": merged_states}
