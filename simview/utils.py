import gzip
import socket
from pathlib import Path

# gzip magic bytes (RFC 1952): every gzip member starts with these two bytes,
# regardless of the file extension used on disk.
_GZIP_MAGIC = b"\x1f\x8b"


def find_free_port(host: str, base_port: int):
    port = base_port
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
                return port
            except OSError:
                port += 1


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
