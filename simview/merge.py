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

Each file may contribute a *subset* of its own batches (see
`parse_batch_selection`), so comparing several methods that each shipped their
own copy of a shared ground truth doesn't mean merging that ground truth once
per file.
"""

import base64
import bisect
import json
import logging
import re
import struct
from pathlib import Path
from typing import Sequence

try:
    import orjson
except ImportError:
    orjson = None

from .columnar import expand_columnar_states, is_columnar
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


# Separates a file from the batches to take out of it in a CLI input spec
# ("scene.json#1,3"). Deliberately not ':', which already means "remote host"
# (see simview.remote).
_BATCH_SPEC_SEP = "#"
_INDEX_RE = re.compile(r"^-?\d+$")
_RANGE_RE = re.compile(r"^(\d+)-(\d+)$")


def split_batch_spec(spec: str) -> tuple[str, str | None]:
    """Split a CLI input like ``scene.json#1,3`` into ``("scene.json", "1,3")``,
    or return ``(spec, None)`` when it names no batch subset.

    Purely syntactic apart from one filesystem check: an existing local file
    wins over the selector reading (mirroring `remote.is_remote_spec`), so a
    file literally named ``odd#name.json`` still opens as itself.
    """
    if _BATCH_SPEC_SEP not in spec:
        return spec, None
    try:
        if Path(spec).exists():
            return spec, None
    except OSError:
        pass
    head, _, selector = spec.rpartition(_BATCH_SPEC_SEP)
    if not head or not selector:
        raise ValueError(
            f"Malformed batch selection '{spec}'; expected "
            f"'file{_BATCH_SPEC_SEP}<batches>', e.g. 'scene.json{_BATCH_SPEC_SEP}1' "
            f"or 'scene.json{_BATCH_SPEC_SEP}0,2-3'."
        )
    return head, selector


def parse_batch_selection(
    selector: str | Sequence[int],
    batch_size: int,
    batch_names: Sequence[str] | None,
    label: str,
) -> list[int]:
    """Resolve one file's batch selector to a list of that file's batch indices.

    `selector` is either an explicit sequence of indices or a comma-separated
    string whose entries are an index (``2``), a negative index counting from
    the end (``-1``), an inclusive range (``0-3``), or one of the file's own
    `batchNames`. Anything that parses as an index or a range is read as such,
    so a batch *named* "2" can only be selected by its index. The selected
    order is the merged order, and selecting the same batch twice is rejected
    as a typo rather than silently duplicating it.
    """
    if isinstance(selector, str):
        raw: list[int] = []
        for token in selector.split(","):
            token = token.strip()
            if not token:
                raise ValueError(
                    f"'{label}': empty entry in batch selection '{selector}'."
                )
            if _INDEX_RE.match(token):
                raw.append(int(token))
                continue
            span = _RANGE_RE.match(token)
            if span:
                start, end = int(span.group(1)), int(span.group(2))
                if end < start:
                    raise ValueError(
                        f"'{label}': batch range '{token}' ends before it starts."
                    )
                raw.extend(range(start, end + 1))
                continue
            names = list(batch_names or [])
            if token in names:
                if names.count(token) > 1:
                    raise ValueError(
                        f"'{label}': '{token}' names {names.count(token)} of its "
                        "batches; select one of them by index instead."
                    )
                raw.append(names.index(token))
                continue
            known = (
                f"one of its batch names ({', '.join(names)})"
                if names
                else "a batch name (this file declares no 'batchNames')"
            )
            raise ValueError(
                f"'{label}': '{token}' is not a batch index, an 'a-b' range, or "
                f"{known}."
            )
    else:
        raw = [int(i) for i in selector]

    resolved: list[int] = []
    for index in raw:
        # Negative indices count from the end, as in Python slicing, so '-1'
        # means "the last batch" without knowing the file's batch count.
        actual = index + batch_size if index < 0 else index
        if not 0 <= actual < batch_size:
            raise ValueError(
                f"'{label}': batch {index} is out of range; the file has "
                f"{batch_size} batch(es) (valid indices 0-{batch_size - 1})."
            )
        resolved.append(actual)
    if not resolved:
        raise ValueError(f"'{label}': batch selection is empty.")
    duplicates = sorted({i for i in resolved if resolved.count(i) > 1})
    if duplicates:
        raise ValueError(
            f"'{label}': batch(es) {', '.join(str(d) for d in duplicates)} "
            "selected more than once."
        )
    return resolved


def _select(rows: Sequence, selection: list[int] | None) -> list:
    """Pick `selection`'s rows out of an already fully expanded per-batch list
    (one row per batch of the source file). A None selection keeps every row,
    which is what every field does when no subset was asked for."""
    if selection is None:
        return list(rows)
    return [rows[i] for i in selection]


def _output_sizes(
    batch_sizes: list[int], selections: list[list[int] | None]
) -> list[int]:
    """How many batches each file contributes to the merged scene."""
    return [
        size if selection is None else len(selection)
        for size, selection in zip(batch_sizes, selections)
    ]


def _decode_b64_floats(value) -> tuple[float, ...] | None:
    """Decode a binary ``__b64__`` blob to a flat tuple of floats, or return
    None if `value` isn't such a blob (e.g. it's an already-batched plain
    list). Kept dependency-free (no numpy/torch) so it works in
    viewing-only installs."""
    if not (isinstance(value, str) and value.startswith("__b64__")):
        return None
    raw = base64.b64decode(value[7:])
    return struct.unpack(f"<{len(raw) // 4}f", raw)


def _encode_b64_floats(flat: list[float]) -> str:
    """Inverse of `_decode_b64_floats`: pack a flat float list as a
    little-endian float32 ``__b64__`` blob string."""
    return "__b64__" + base64.b64encode(struct.pack(f"<{len(flat)}f", *flat)).decode(
        "ascii"
    )


def _decode_state_field(value, width: int):
    """Expand a binary ``__b64__`` per-body state field to a list of per-batch
    rows. Plain lists pass through unchanged, so merged output is always JSON
    lists regardless of whether inputs used binary encoding."""
    flat = _decode_b64_floats(value)
    if flat is None:
        return value
    return [list(flat[i : i + width]) for i in range(0, len(flat), width)]


def _decode_per_batch(
    value: list | str,
    batch_size: int,
    resolution: int,
    vector_width: int | None = None,
) -> list:
    """Normalize a terrain data field (heightData/normals/a named property's
    data) to a plain list of length `batch_size`, one entry per batch,
    regardless of whether it's a binary ``__b64__`` blob or an already-batched
    plain list. Used so that inputs mixing binary and plain-list encoding can
    still be concatenated -- each file's field is decoded independently rather
    than branching on a single file's encoding.

    A blob's row layout is resolved by its length against the known per-row
    size (`resolution * vector_width` floats): a singleton terrain ships one
    shared row (replicated out to `batch_size` here), while per-batch (or
    legacy broadcast-singleton) data holds `batch_size` rows.

    A decoded ``__b64__`` blob is flat, so a vector-valued field (normals:
    `vector_width=3`) needs its per-batch chunk grouped into width-wide
    vectors to match SimViewTerrain.normals' canonical
    `list[batch][vertex][xyz]` shape -- otherwise each batch would stay a
    flat float list, which is indistinguishable on the JS side from a single
    unbatched list of vectors (see Terrain.js's #normalizeVectorField)."""
    flat = _decode_b64_floats(value)
    if flat is None:
        # `_decode_b64_floats` only returns None for non-`__b64__` input, and
        # the only `str` values these terrain fields ever take on are
        # `__b64__` blobs (see `_expand_batched`, which requires a `str` here
        # to start with that prefix) -- so a plain (non-b64) `value` is
        # always a `list` at this point.
        assert isinstance(value, list)
        return value
    per_row = resolution * (vector_width or 1)
    if len(flat) == per_row:
        # One shared row (deduplicated singleton terrain).
        chunks = [list(flat)] * batch_size
    elif len(flat) == batch_size * per_row:
        chunks = [list(flat[i : i + per_row]) for i in range(0, len(flat), per_row)]
    else:
        raise ValueError(
            f"terrain blob has {len(flat)} floats; expected {per_row} (one "
            f"shared row) or {batch_size * per_row} ({batch_size} batches "
            f"x {per_row})"
        )
    if vector_width is None:
        return chunks
    return [
        [row[i : i + vector_width] for i in range(0, len(row), vector_width)]
        for row in chunks
    ]


def _load_json(path: Path) -> dict:
    raw = read_maybe_gzipped_bytes(path)
    doc = orjson.loads(raw) if orjson else json.loads(raw)
    # Merging works frame by frame (resampling onto the first file's timeline),
    # so a columnar file is expanded to the per-frame layout up front rather
    # than teaching every step below a second shape. expand_columnar_states is
    # stdlib-only, so this keeps merge usable on a base install.
    if isinstance(doc, dict) and is_columnar(doc.get("states")):
        model = doc.get("model")
        batch_size = int((model or {}).get("simBatches", 1))
        doc["states"] = expand_columnar_states(doc["states"], batch_size)
    return doc


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
    # b64 blobs pass through untouched: _decode_per_batch resolves their row
    # layout by length (one shared row for a deduplicated singleton terrain,
    # or batch_size rows for per-batch / legacy broadcast-singleton data) and
    # replicates the shared case itself. Only plain lists (where the row count
    # is directly observable) may need broadcasting below.
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


def _default_batch_names(
    paths: Sequence[Path], batch_sizes: list[int], selections: list[list[int] | None]
) -> list[str]:
    """One name per output batch, derived from the source file it came from.
    Single-batch files just use the file stem; multi-batch files get an index
    suffix so batches from the same file are still distinguishable. The suffix
    is the batch's index *in its source file*, so a selected subset stays
    traceable back to it (batch 2 of a 4-batch 'run.json' is 'run[2]', not
    'run[0]')."""
    names = []
    for path, batch_size, selection in zip(paths, batch_sizes, selections):
        stem = path.stem
        if batch_size == 1:
            names.append(stem)
        else:
            indices = range(batch_size) if selection is None else selection
            names.extend(f"{stem}[{j}]" for j in indices)
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
    models: list[dict],
    batch_sizes: list[int],
    labels: list[str],
    selections: list[list[int] | None],
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
            for model, batch_size, label, selection in zip(
                models, batch_sizes, labels, selections
            ):
                shapes.extend(
                    _select(
                        _expand_batched(
                            model["staticObjects"][idx]["shapes"],
                            False,
                            batch_size,
                            "shapes",
                            label,
                        ),
                        selection,
                    )
                )
            entry["shapes"] = shapes
        merged.append(entry)
    return merged


def _merge_embedding(
    models: list[dict],
    batch_sizes: list[int],
    labels: list[str],
    resolution: int,
    selections: list[list[int] | None],
) -> str | None:
    """Concatenate the per-batch terrain `embeddingData` of every file into a
    single ``__b64__`` blob (the encoding the viewer's Terrain.js splits per
    batch), or return None (dropping it with a warning, mirroring the
    all-or-nothing rule named properties use) when only some files have it or
    their per-cell widths (K) differ.

    K isn't shipped explicitly anywhere (the viewer infers it from the flat
    length), so each file's layout is resolved from its length: a per-batch
    blob holds `batch_size * resolution * K` floats; a singleton file may
    instead hold one shared `resolution * K` row (or, for files written
    before shared terrain stopped being broadcast, `batch_size` identical
    copies of it)."""
    values = [m["terrain"].get("embeddingData") for m in models]
    if all(v is None for v in values):
        return None
    if any(v is None for v in values):
        logger.warning(
            "Not all files provide terrain embeddingData; dropping it from "
            "the merged terrain."
        )
        return None

    per_file_rows: list[list[list[float]]] = []
    widths: list[int] = []
    for model, value, batch_size, label, selection in zip(
        models, values, batch_sizes, labels, selections
    ):
        flat = _decode_b64_floats(value)
        if flat is None:
            # Real producers always blob-encode embeddings; a plain list is
            # a flat single-batch array (see Terrain.js #initEmbeddingData).
            flat = tuple(float(x) for x in value)
        if len(flat) % resolution != 0:
            raise ValueError(
                f"'{label}': embeddingData has {len(flat)} floats, not a "
                f"multiple of the terrain resolution ({resolution})."
            )
        singleton = model["terrain"].get("isSingleton", False)
        per_batch = len(flat) // batch_size if len(flat) % batch_size == 0 else None
        if singleton:
            if per_batch is None or per_batch % resolution != 0:
                # Genuinely one shared row that batch_size doesn't divide into.
                rows = [list(flat)] * batch_size
            else:
                # Ambiguous: could be one shared row or batch_size broadcast
                # copies (the pre-singleton-dedup format). Identical chunks
                # mean broadcast copies; otherwise the whole thing is one row.
                chunks = [
                    list(flat[i : i + per_batch])
                    for i in range(0, len(flat), per_batch)
                ]
                if all(c == chunks[0] for c in chunks):
                    rows = [chunks[0]] * batch_size
                else:
                    rows = [list(flat)] * batch_size
        else:
            if per_batch is None:
                raise ValueError(
                    f"'{label}': embeddingData has {len(flat)} floats; not "
                    f"divisible into {batch_size} batches."
                )
            rows = [
                list(flat[i : i + per_batch]) for i in range(0, len(flat), per_batch)
            ]
        rows = _select(rows, selection)
        per_file_rows.append(rows)
        widths.append(len(rows[0]) // resolution)

    if len(set(widths)) > 1:
        logger.warning(
            "Terrain embeddingData widths differ across files (%s); dropping "
            "it from the merged terrain.",
            dict(zip(labels, widths)),
        )
        return None

    merged_flat: list[float] = []
    for rows in per_file_rows:
        for row in rows:
            merged_flat.extend(row)
    return _encode_b64_floats(merged_flat)


def _merge_terrain(
    models: list[dict],
    batch_sizes: list[int],
    labels: list[str],
    selections: list[list[int] | None],
) -> dict:
    first_terrain = models[0]["terrain"]
    dims = first_terrain["dimensions"]
    # The x/y extent must match too, not just the grid resolution: two
    # terrains of the same size/resolution but different origins would merge
    # into spatially misaligned batches with no error anywhere. minZ/maxZ are
    # legitimately per-file (merged via min/max below), so only x/y bounds
    # are required to be identical.
    xy_bounds_keys = ("minX", "maxX", "minY", "maxY")
    first_xy = {k: first_terrain["bounds"][k] for k in xy_bounds_keys}
    for model, label in zip(models[1:], labels[1:]):
        other_dims = model["terrain"]["dimensions"]
        if other_dims != dims:
            raise ValueError(
                f"'{label}' terrain dimensions {other_dims} do not match "
                f"'{labels[0]}' dimensions {dims}."
            )
        other_xy = {k: model["terrain"]["bounds"][k] for k in xy_bounds_keys}
        if other_xy != first_xy:
            raise ValueError(
                f"'{label}' terrain x/y bounds {other_xy} do not match "
                f"'{labels[0]}' bounds {first_xy}."
            )

    # Union of property names across all files, in first-seen order. A property
    # present in every file is kept (concatenated + bounds merged); one present
    # in only some is dropped with a warning, same all-or-nothing rule as
    # heightData/normals require unconditionally.
    property_names: list[str] = []
    for model in models:
        for name in model["terrain"].get("properties") or {}:
            if name not in property_names:
                property_names.append(name)
    kept_properties = []
    for name in property_names:
        present_in_all = all(
            name in (model["terrain"].get("properties") or {}) for model in models
        )
        if present_in_all:
            kept_properties.append(name)
        else:
            logger.warning(
                "Not all files provide terrain property '%s'; dropping it "
                "from the merged terrain.",
                name,
            )

    resolution = int(dims["resolutionX"]) * int(dims["resolutionY"])

    def _concat_lists_or_b64(
        items: list[tuple], vector_width: int | None = None
    ) -> list | None:
        # Each item is decoded independently, keyed by its own batch_size (not
        # branched on items[0]'s encoding), so a mix of binary and plain-list
        # inputs merges correctly instead of crashing -- or silently
        # corrupting shapes -- on a differently-encoded item.
        if not items:
            return None
        merged = []
        for value, batch_size, selection in items:
            merged.extend(
                _select(
                    _decode_per_batch(value, batch_size, resolution, vector_width),
                    selection,
                )
            )
        return merged

    height_data, normals = [], []
    property_data: dict[str, list] = {name: [] for name in kept_properties}
    min_z = max_z = None
    property_min_max: dict[str, tuple[float | None, float | None]] = {
        name: (None, None) for name in kept_properties
    }
    for model, batch_size, label, selection in zip(
        models, batch_sizes, labels, selections
    ):
        terrain = model["terrain"]
        singleton = terrain.get("isSingleton", False)
        height_data.append(
            (
                _expand_batched(
                    terrain["heightData"], singleton, batch_size, "heightData", label
                ),
                batch_size,
                selection,
            )
        )
        normals.append(
            (
                _expand_batched(
                    terrain["normals"], singleton, batch_size, "normals", label
                ),
                batch_size,
                selection,
            )
        )

        bounds = terrain["bounds"]
        min_z = bounds["minZ"] if min_z is None else min(min_z, bounds["minZ"])
        max_z = bounds["maxZ"] if max_z is None else max(max_z, bounds["maxZ"])
        for name in kept_properties:
            prop = terrain["properties"][name]
            property_data[name].append(
                (
                    _expand_batched(prop["data"], singleton, batch_size, name, label),
                    batch_size,
                    selection,
                )
            )
            cur_min, cur_max = property_min_max[name]
            property_min_max[name] = (
                prop["min"] if cur_min is None else min(cur_min, prop["min"]),
                prop["max"] if cur_max is None else max(cur_max, prop["max"]),
            )

    merged_bounds = {
        "minX": first_terrain["bounds"]["minX"],
        "maxX": first_terrain["bounds"]["maxX"],
        "minY": first_terrain["bounds"]["minY"],
        "maxY": first_terrain["bounds"]["maxY"],
        "minZ": min_z,
        "maxZ": max_z,
    }

    merged_properties = {
        name: {
            "data": _concat_lists_or_b64(property_data[name]),
            "min": property_min_max[name][0],
            "max": property_min_max[name][1],
        }
        for name in kept_properties
    }

    merged = {
        "dimensions": dims,
        "bounds": merged_bounds,
        "isSingleton": False,
        "heightData": _concat_lists_or_b64(height_data),
        "normals": _concat_lists_or_b64(normals, vector_width=3),
        "properties": merged_properties,
    }
    embedding = _merge_embedding(models, batch_sizes, labels, resolution, selections)
    if embedding is not None:
        merged["embeddingData"] = embedding
    return merged


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
    selections: list[list[int] | None],
) -> list[dict]:
    ref_times = [s["time"] for s in states_list[0]]
    times_by_file = [[s["time"] for s in states] for states in states_list]
    total_batches = sum(_output_sizes(batch_sizes, selections))
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
            if body.get("localTransform") is not None:
                # Rigidly-attached body: never appears in any state's `bodies[]`
                # (its pose is derived by the viewer from its parent + this
                # constant offset), so there's nothing to merge -- keep the
                # merged output just as compact by skipping it here too.
                continue
            available = set(body.get("availableAttributes") or [])
            transform = []
            attr_values = {
                attr: [] for attr in _OPTIONAL_VECTOR_ATTRS if attr in available
            }
            contacts = [] if "contacts" in available else None

            for file_idx, (states, batch_size, selection) in enumerate(
                zip(states_list, batch_sizes, selections)
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
                    _select(
                        _normalize_per_batch(
                            _decode_state_field(
                                body_state["bodyTransform"],
                                _STATE_FIELD_WIDTHS["bodyTransform"],
                            ),
                            batch_size,
                        ),
                        selection,
                    )
                )
                for attr in attr_values:
                    if attr not in body_state:
                        raise ValueError(
                            f"'{labels[file_idx]}' body '{name}' declares '{attr}' as "
                            f"available but is missing it at t={states[state_idx]['time']}."
                        )
                    attr_values[attr].extend(
                        _select(
                            _normalize_per_batch(
                                _decode_state_field(
                                    body_state[attr], _STATE_FIELD_WIDTHS[attr]
                                ),
                                batch_size,
                            ),
                            selection,
                        )
                    )
                if contacts is not None:
                    if "contacts" not in body_state:
                        raise ValueError(
                            f"'{labels[file_idx]}' body '{name}' declares 'contacts' as "
                            f"available but is missing it at t={states[state_idx]['time']}."
                        )
                    contacts.extend(_select(body_state["contacts"], selection))

            if len(transform) != total_batches:
                raise ValueError(
                    f"Merged 'bodyTransform' for body '{name}' has {len(transform)} "
                    f"rows; expected {total_batches} (sum of the merged batch "
                    f"counts across {', '.join(repr(label) for label in labels)}). "
                    "Check that each file's per-body state rows match its "
                    "declared simBatches."
                )
            merged_body = {"name": name, "bodyTransform": transform, **attr_values}
            if contacts is not None:
                merged_body["contacts"] = contacts
            merged_bodies.append(merged_body)

        merged_state = {"time": t, "bodies": merged_bodies}
        for scalar_name in scalar_names:
            values = []
            for file_idx, (states, batch_size, selection) in enumerate(
                zip(states_list, batch_sizes, selections)
            ):
                state_idx = state_idx_by_file[file_idx]
                scalar_values = states[state_idx].get(scalar_name)
                if scalar_values is None:
                    raise ValueError(
                        f"'{labels[file_idx]}' is missing scalar '{scalar_name}' at "
                        f"t={states[state_idx]['time']}."
                    )
                values.extend(_select(scalar_values, selection))
            merged_state[scalar_name] = values
        merged_states.append(merged_state)

    return merged_states


def merge_simulation_files(
    paths: Sequence[str | Path],
    selections: Sequence[str | Sequence[int] | None] | None = None,
) -> dict:
    """Load and merge `paths` into a single `{"model": ..., "states": ...}` dict
    where each file's batches are concatenated into the output's batch dimension.

    `selections`, if given, must be parallel to `paths`: each entry is None
    (contribute every batch of that file) or a batch selector -- a string like
    ``"1"``, ``"0,2"``, ``"1-3"``, ``"-1"`` or a batch name, or an explicit
    sequence of indices (see `parse_batch_selection`). Selecting a subset is
    what lets several files that each carry the same ground-truth batch be
    merged without duplicating it, and it is the one case where a single file
    is a valid merge input.
    """
    resolved_paths = [Path(p) for p in paths]
    if selections is None:
        requested: list[str | Sequence[int] | None] = [None] * len(resolved_paths)
    else:
        requested = list(selections)
        if len(requested) != len(resolved_paths):
            raise ValueError(
                f"merge_simulation_files got {len(requested)} batch selection(s) "
                f"for {len(resolved_paths)} file(s); they must be parallel."
            )
    if len(resolved_paths) < 2 and all(s is None for s in requested):
        raise ValueError(
            "merge_simulation_files requires at least 2 files (or one file with "
            "a batch selection, to keep only some of its batches)"
        )

    labels = [p.name for p in resolved_paths]
    docs = [_load_json(p) for p in resolved_paths]
    for doc, label in zip(docs, labels):
        _validate_doc(doc, label)
    models = [doc["model"] for doc in docs]
    states_list = [doc["states"] for doc in docs]
    batch_sizes = [int(m.get("simBatches", 1)) for m in models]
    # Resolved here rather than at the call site because a selector may name a
    # batch by name or by a negative index, both of which need the file loaded.
    batch_selections: list[list[int] | None] = [
        None
        if selector is None
        else parse_batch_selection(selector, batch_size, model.get("batchNames"), label)
        for selector, batch_size, model, label in zip(
            requested, batch_sizes, models, labels
        )
    ]

    bodies = _merge_bodies(models, labels)
    scalar_names = _merge_scalar_names(models, labels)
    static_objects = _merge_static_objects(
        models, batch_sizes, labels, batch_selections
    )
    terrain = _merge_terrain(models, batch_sizes, labels, batch_selections)
    merged_states = _merge_states(
        states_list, batch_sizes, bodies, scalar_names, labels, batch_selections
    )

    out_sizes = _output_sizes(batch_sizes, batch_selections)
    total_batches = sum(out_sizes)
    offsets = [sum(out_sizes[:i]) for i in range(len(out_sizes))]
    ranges = ", ".join(
        f"'{label}'"
        + (
            ""
            if selection is None
            else f" (source batches {', '.join(str(i) for i in selection)})"
        )
        + f" -> batches {offset}-{offset + size - 1}"
        for label, offset, size, selection in zip(
            labels, offsets, out_sizes, batch_selections
        )
    )
    logger.info(
        "Merged %d files into %d batches (%s)", len(paths), total_batches, ranges
    )

    merged_model = {
        "simBatches": total_batches,
        "batchNames": _default_batch_names(
            resolved_paths, batch_sizes, batch_selections
        ),
        "scalarNames": scalar_names,
        "dt": models[0].get("dt"),
        "collapse": models[0].get("collapse", False),
        "terrain": terrain,
        "bodies": bodies,
        "staticObjects": static_objects,
    }
    # Keep every input's run provenance (engine, checkpoint, git commit, ...)
    # instead of silently dropping it -- namespaced per source file since the
    # inputs may come from entirely different runs.
    source_metadata = {
        label: model["metadata"]
        for model, label in zip(models, labels)
        if model.get("metadata") is not None
    }
    if source_metadata:
        merged_model["metadata"] = {"sources": source_metadata}

    # Episode boundaries are indices into a specific timeline. The merged
    # timeline *is* the first file's (everything else is resampled onto it), so
    # only its episodes still mean anything -- the others' indices would point
    # at the wrong frames.
    if models[0].get("episodes"):
        merged_model["episodes"] = models[0]["episodes"]
    dropped = [
        label for model, label in zip(models[1:], labels[1:]) if model.get("episodes")
    ]
    if dropped:
        logger.warning(
            "Dropping episode boundaries from %s: they index their own "
            "timeline, and the merged scene uses '%s'’s timeline.",
            ", ".join(f"'{label}'" for label in dropped),
            labels[0],
        )

    return {"model": merged_model, "states": merged_states}
