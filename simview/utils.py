import gzip
import json
import socket
from pathlib import Path
from typing import Any

# gzip magic bytes (RFC 1952): every gzip member starts with these two bytes,
# regardless of the file extension used on disk.
_GZIP_MAGIC = b"\x1f\x8b"


_MAX_PORT = 65535


def find_free_port(host: str, base_port: int) -> int:
    """Return the first free TCP port on `host` starting at `base_port`.

    Raises OSError if no port is free up to the maximum valid port number
    (65535), rather than looping forever.
    """
    port = base_port
    while port <= _MAX_PORT:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
                return port
            except OSError:
                port += 1
    raise OSError(f"No free port found on {host} in range [{base_port}, {_MAX_PORT}].")


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


def cap(items: list, n: int) -> tuple[list, bool]:
    """`(first n items, whether anything was dropped)` -- for capped terminal
    renderings of otherwise-untruncated result dicts."""
    return items[:n], len(items) > n


def load_scene_model(path: str | Path) -> dict:
    """Read the scene JSON at `path` (transparently gunzipped) and return its
    `model` section. Raises `ValueError`/`json.JSONDecodeError` on malformed
    input -- callers decide how to report that."""
    data = json.loads(read_maybe_gzipped_bytes(path))
    if not isinstance(data, dict):
        raise ValueError("scene file must contain a JSON object with a 'model' key")
    model = data.get("model")
    if model is None:
        raise ValueError("scene file has no 'model' section")
    return model


def load_scene(path: str | Path) -> tuple[dict, list]:
    """Read the scene JSON at `path` (transparently gunzipped) and return its
    `(model, states)` sections, expanding a columnar `states` document into the
    per-frame layout the stdlib-only readers walk. Raises
    `ValueError`/`json.JSONDecodeError` on malformed input."""
    from simview.columnar import expand_columnar_states, is_columnar

    data = json.loads(read_maybe_gzipped_bytes(path))
    if not isinstance(data, dict):
        raise ValueError(
            "scene file must contain a JSON object with 'model'/'states' keys"
        )
    model = data.get("model")
    states = data.get("states")
    if model is None:
        raise ValueError("scene file has no 'model' section")
    if states is None:
        raise ValueError("scene file has no 'states' section")
    if is_columnar(states):
        states = expand_columnar_states(states, int(model.get("simBatches") or 1))
    return model, states
