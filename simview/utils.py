import gzip
import socket
from pathlib import Path

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
