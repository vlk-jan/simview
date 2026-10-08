import csv
import gzip
import io
import json
import logging
import socket
from pathlib import Path
from typing import Any

from simview.columnar import (
    COLUMNAR_VERSION,
    body_key,
    expand_columnar_states,
    is_columnar,
)

# gzip magic bytes (RFC 1952): every gzip member starts with these two bytes,
# regardless of the file extension used on disk.
_GZIP_MAGIC = b"\x1f\x8b"


_MAX_PORT = 65535

logger = logging.getLogger("simview.utils")


def find_free_port(host: str, base_port: int) -> int:
    """Return the first free TCP port on `host` starting at `base_port`.

    Logs a warning when `base_port` itself is taken. Raises OSError if no
    port is free up to the maximum valid port number (65535), rather than
    looping forever.
    """
    # Resolve the family once ("::1"/"::" need AF_INET6; AF_INET would fail on
    # every port and report "no free port").
    try:
        family, _, _, _, sockaddr = socket.getaddrinfo(
            host, base_port, type=socket.SOCK_STREAM
        )[0]
    except socket.gaierror as e:
        raise OSError(f"Cannot resolve host {host!r}: {e}") from e
    for port in range(base_port, _MAX_PORT + 1):
        with socket.socket(family, socket.SOCK_STREAM) as s:
            try:
                s.bind((sockaddr[0], port, *sockaddr[2:]))
            except OSError:
                continue
        if port != base_port:
            logger.warning(
                "Preferred port %s is not available. Using port %s instead.",
                base_port,
                port,
            )
        return port
    raise OSError(f"No free port found on {host} in range [{base_port}, {_MAX_PORT}].")


def dialable_host(host: str) -> str:
    """Host to put in URLs -- 0.0.0.0/:: aren't dialable, so localhost stands
    in for them."""
    return "127.0.0.1" if host in ("0.0.0.0", "::") else host


def read_maybe_gzipped_bytes(path: str | Path) -> bytes:
    """Read `path` and transparently gunzip it if it's gzip-compressed.

    Detection is by magic bytes (0x1f 0x8b), not file extension, so a
    gzip-compressed scene works regardless of whether it's named ``*.gz``.
    Kept dependency-free (no numpy/torch/orjson) so it works in viewing-only
    installs; callers decide which JSON library to feed the returned bytes to.
    """
    raw = Path(path).read_bytes()
    if raw[:2] == _GZIP_MAGIC:
        return gzip.decompress(raw)
    return raw


def human_bytes(n: int) -> str:
    """Byte count as a short human-readable string (e.g. '1.5MB')."""
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f}{unit}" if unit != "B" else f"{int(size)}B"
        size /= 1024
    return f"{size:.1f}GB"


def body_label(name: Any) -> str:
    """Display label for a body `name` -- a plain string, or the names of a
    rigidly-grouped body joined with '+'."""
    return name if isinstance(name, str) else "+".join(str(n) for n in name)


def iter_names(name: Any):
    """Yield the individual body names inside a `name` (str or list)."""
    yield from name if isinstance(name, list) else (name,)


def bodies_by_name(raw_bodies: list | None) -> dict:
    """`name -> entry` for one state's `bodies`, expanding grouped (list) name
    entries so each individual body name maps to the shared entry."""
    return {
        single: entry
        for entry in raw_bodies or []
        if entry.get("name") is not None
        for single in iter_names(entry["name"])
    }


def collect_body_names(states_data: list) -> list:
    """All distinct body names/name-groups seen across `states_data`, in
    first-seen order -- the candidate pool `resolve_body` matches against."""
    seen: dict = {}
    for state in states_data:
        for entry in state.get("bodies") or []:
            name = entry.get("name")
            if name is not None:
                seen.setdefault(body_key(name), name)
    return list(seen.values())


def resolve_body(all_names: list, body: str | None) -> list:
    """Narrow `all_names` to the single body `body` refers to (by full label or
    by any one name inside a rigidly-grouped body), or return them all when
    `body` is None. Raises ValueError if it matches nothing or is ambiguous."""
    if body is None:
        return all_names
    matches = [n for n in all_names if body_label(n) == body or body in iter_names(n)]
    if not matches:
        available = ", ".join(body_label(n) for n in all_names)
        raise ValueError(
            f"body '{body}' not found in any state; available bodies: {available}"
        )
    if len(matches) > 1:
        labels = ", ".join(body_label(n) for n in matches)
        raise ValueError(
            f"body '{body}' is ambiguous; matches {labels}; pass the full label instead"
        )
    return matches


def write_csv(header: list[str], rows) -> str:
    """`header` plus `rows` rendered as one CSV string."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    writer.writerows(rows)
    return buf.getvalue()


def series_stats(values: list[float]) -> dict:
    """`{"mean", "min", "max", "final"}` of a numeric series (all None when
    empty)."""
    if not values:
        return {"mean": None, "min": None, "max": None, "final": None}
    return {
        "mean": sum(values) / len(values),
        "min": min(values),
        "max": max(values),
        "final": values[-1],
    }


def cap(items: list, n: int) -> tuple[list, bool]:
    """`(first n items, whether anything was dropped)` -- for capped terminal
    renderings of otherwise-untruncated result dicts."""
    return items[:n], len(items) > n


def _load_doc(path: str | Path) -> dict:
    """Read the scene JSON at `path` (transparently gunzipped), requiring a
    top-level object with a `model` section."""
    data = json.loads(read_maybe_gzipped_bytes(path))
    if not isinstance(data, dict):
        raise ValueError("scene file must contain a JSON object with a 'model' key")
    if data.get("model") is None:
        raise ValueError("scene file has no 'model' section")
    return data


def load_scene_model(path: str | Path) -> dict:
    """Read the scene JSON at `path` (transparently gunzipped) and return its
    `model` section. Raises `ValueError`/`json.JSONDecodeError` on malformed
    input -- callers decide how to report that."""
    return _load_doc(path)["model"]


def load_scene(path: str | Path) -> tuple[dict, list]:
    """Read the scene JSON at `path` (transparently gunzipped) and return its
    `(model, states)` sections, expanding a columnar `states` document into the
    per-frame layout the stdlib-only readers walk. Raises
    `ValueError`/`json.JSONDecodeError` on malformed input."""
    data = _load_doc(path)
    model, states = data["model"], data.get("states")
    if states is None:
        raise ValueError("scene file has no 'states' section")
    if is_columnar(states):
        states = expand_columnar_states(states, int(model.get("simBatches") or 1))
    if not isinstance(states, list):
        raise ValueError(
            "scene file 'states' must be a per-frame list or a columnar "
            f"(version {COLUMNAR_VERSION}) object"
        )
    return model, states
