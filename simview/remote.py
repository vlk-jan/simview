"""Fetch scene files from another host over SSH, into a local cache.

`simview rci:~/results/scene.json` should behave exactly like `simview scene.json`
after an `scp`. This module is the whole of that: it turns an scp-style
``host:path`` spec into a local `Path`, and every other part of the codebase
(server, merge, info/diff/terrain/render) keeps seeing an ordinary local file.

Two properties are load-bearing:

* **The cached copy is byte-identical to the remote file.** Compression is a
  transport detail, undone on arrival. That is what keeps `simview info`'s
  reported size/gzipped honest, keeps `merge_simulation_files`' batch labels
  (which come from the file's basename) readable, and lets `read_maybe_gzipped_bytes`
  handle a remote ``*.json.gz`` with no special casing.
* **The cache entry carries the remote file's mtime and size**, via `os.utime`
  after the fetch. Freshness is then a plain stat comparison with no metadata
  sidecar to keep in sync, and `SimViewServer._source_fingerprint` (which keys
  persisted batch names off mtime) stays stable across runs.

Saving bandwidth is the point of the feature, so the transfer is compressed
explicitly with a remote `gzip` rather than relying on `ssh -C`, whose server
side can be turned off (`Compression no`) with no signal to us. Which of the
three transfer modes applies is decided by the probe below, before any bytes
move, so the local decoder always knows what it is receiving.

Stdlib-only on purpose: `simview info`/`diff`/`terrain` must keep working on a
base install with no extras, and they resolve their inputs through here.
"""

import hashlib
import logging
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import zlib
from pathlib import Path

from simview import CACHE_DIR

logger = logging.getLogger("simview.remote")

# Deliberately restrictive: a single-character host is rejected so a Windows
# drive letter ("C:\scenes\x.json") is never mistaken for a hostname.
_HOST_RE = re.compile(r"^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]{2,}$")
_USER_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_TILDE_RE = re.compile(r"^~[A-Za-z0-9._-]*$")

_CHUNK = 1 << 20
_PROGRESS_STEP = 32 << 20


class RemoteError(Exception):
    """A remote spec could not be resolved (bad spec, ssh failure, missing file)."""


def human_bytes(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f}{unit}" if unit != "B" else f"{int(size)}B"
        size /= 1024
    return f"{size:.1f}GB"


def parse_remote_spec(spec: str) -> tuple[str, str] | None:
    """Split `spec` into (ssh host, remote path), or None if it isn't remote.

    Purely syntactic -- it never touches the filesystem, so `is_remote_spec` is
    the one that gives an existing local file priority over a host-looking name.
    """
    if spec.startswith("ssh://"):
        host, sep, path = spec[len("ssh://") :].partition("/")
        if not sep or not host:
            raise RemoteError(
                f"Malformed remote URL '{spec}'; expected ssh://host/path."
            )
        if ":" in host:
            raise RemoteError(
                f"Remote URL '{spec}' specifies a port, which is not supported; "
                "add a 'Host' entry with a 'Port' to your ~/.ssh/config instead."
            )
        return _normalize_host(host), "/" + path

    # Bracketed IPv6 literal, scp-style: [::1]:path or user@[::1]:path.
    bracket = spec.find("]:")
    if bracket != -1 and "[" in spec[:bracket]:
        host = spec[: bracket + 1]
        path = spec[bracket + 2 :]
        user, _, addr = host.rpartition("@")
        if not path or not addr.startswith("[") or (user and not _USER_RE.match(user)):
            return None
        return _normalize_host(host), path

    host, sep, path = spec.partition(":")
    if not sep or not path or not _HOST_RE.match(host):
        return None
    return host, path


def _normalize_host(host: str) -> str:
    """Strip the brackets off an IPv6 literal -- ssh(1) wants '::1', not '[::1]'."""
    user, at, addr = host.rpartition("@")
    if addr.startswith("[") and addr.endswith("]"):
        addr = addr[1:-1]
    return f"{user}{at}{addr}"


def _local_exists(spec: str) -> bool:
    try:
        return Path(spec).exists()
    except OSError:
        return False


def is_remote_spec(spec: str) -> bool:
    """Whether `spec` names a file on another host. An existing local file wins,
    so a file literally named 'weird:name.json' still opens as itself."""
    if _local_exists(spec):
        return False
    return parse_remote_spec(spec) is not None


def cache_dir() -> Path:
    """Root of simview's on-disk cache, honouring XDG_CACHE_HOME."""
    base = os.environ.get("XDG_CACHE_HOME")
    root = Path(base) if base else Path.home() / ".cache"
    return root / CACHE_DIR


def cache_entry_path(host: str, remote_path: str) -> Path:
    """One directory per remote spec, the remote basename kept inside it.

    The basename has to survive because `merge_simulation_files` labels each
    file's batches with it -- a merged scene should read 'comparison.json',
    not a hash. The hash therefore goes on the directory instead.
    """
    key = hashlib.sha1(f"{host}:{remote_path}".encode()).hexdigest()[:10]
    safe_host = re.sub(r"[^A-Za-z0-9._-]", "_", host)
    name = remote_path.rstrip("/").rpartition("/")[2] or "scene.json"
    return cache_dir() / "remote" / f"{safe_host}-{key}" / name


def quote_remote_path(path: str) -> str:
    """Shell-quote `path` for the remote sh, keeping a leading '~' expandable.

    `shlex.quote('~/x')` yields `'~/x'`, which sh does *not* tilde-expand, so the
    tilde component is emitted bare (after checking it holds nothing but a plain
    user name) and only the remainder is quoted.
    """
    head, sep, tail = path.partition("/")
    if sep and _TILDE_RE.match(head):
        return head + sep + (shlex.quote(tail) if tail else "")
    return shlex.quote(path)


def _run_ssh(host: str, command: str) -> str:
    """Run `command` on `host` and return its stdout. Small outputs only."""
    try:
        proc = subprocess.run(
            ["ssh", host, command],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except OSError as e:  # pragma: no cover - depends on a broken ssh install
        raise RemoteError(f"Could not run ssh: {e}") from e
    if proc.returncode != 0:
        raise RemoteError(
            f"ssh {host} failed (exit {proc.returncode}): {proc.stderr.strip()}"
        )
    return proc.stdout


def _probe(host: str, remote_path: str) -> tuple[int, int, bool]:
    """One round trip settling both freshness and transfer mode.

    Returns (mtime, size, remote has gzip). The `stat` fallback covers BSD/macOS
    hosts; the explicit `-f` test is there because `stat` succeeds on directories
    and the `|| echo NOGZIP` tail would otherwise mask a missing file behind a
    zero exit status.
    """
    q = quote_remote_path(remote_path)
    script = (
        f"if [ ! -f {q} ]; then "
        f"echo 'no such file, or not a regular file' >&2; exit 3; fi\n"
        f"stat -c '%Y %s' -- {q} 2>/dev/null || stat -f '%m %z' -- {q}\n"
        "if command -v gzip >/dev/null 2>&1; then echo GZIP; else echo NOGZIP; fi\n"
    )
    lines = _run_ssh(host, script).split()
    if len(lines) < 3:
        raise RemoteError(
            f"Could not stat {host}:{remote_path} (unexpected output: {lines!r})."
        )
    try:
        mtime, size = int(lines[0]), int(lines[1])
    except ValueError as e:
        raise RemoteError(
            f"Could not parse the size/mtime of {host}:{remote_path}: {lines!r}"
        ) from e
    return mtime, size, lines[2] == "GZIP"


def _fetch_argv(host: str, remote_path: str, has_gzip: bool) -> tuple[list[str], bool]:
    """The ssh command to stream the file with, and whether to gunzip a layer.

    Gunzipping exactly one layer is right even when the remote file is itself
    gzip data under a non-.gz name: it goes over the wire double-compressed and
    one decompress restores the original bytes. `gzip -1` gets most of the ratio
    on JSON this redundant for a fraction of the CPU on a shared login node.
    """
    q = quote_remote_path(remote_path)
    already_compressed = remote_path.endswith(".gz")
    if has_gzip and not already_compressed:
        return ["ssh", host, f"gzip -c -1 -- {q}"], True
    # No remote gzip: fall back to transport-level zlib, which may or may not be
    # enabled server-side. Skipped for a .gz file, where it would only burn CPU.
    flags = [] if already_compressed else ["-C"]
    return ["ssh", *flags, host, f"cat -- {q}"], False


def _fetch(host: str, remote_path: str, dest: Path, has_gzip: bool, size: int) -> int:
    """Stream the remote file to `dest`, returning the bytes actually transferred.

    Decompression is incremental and the write goes to a '.partial' file that is
    only renamed into place once complete, so a 300MB scene is never held in
    memory whole and an interrupted fetch never leaves a usable-looking cache
    entry behind.
    """
    argv, gunzip = _fetch_argv(host, remote_path, has_gzip)
    decomp = zlib.decompressobj(16 + zlib.MAX_WBITS) if gunzip else None
    partial = dest.with_name(dest.name + ".partial")
    wire = written = next_report = 0

    try:
        # stderr goes to a temp file rather than a pipe so a chatty login banner
        # can't fill the buffer and deadlock against our stdout read loop. stdin
        # stays inherited so ssh can still prompt for a passphrase.
        with tempfile.TemporaryFile() as errf:
            try:
                proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=errf)
            except OSError as e:  # pragma: no cover - broken ssh install
                raise RemoteError(f"Could not run ssh: {e}") from e
            assert proc.stdout is not None
            with open(partial, "wb") as out:
                while True:
                    chunk = proc.stdout.read(_CHUNK)
                    if not chunk:
                        break
                    wire += len(chunk)
                    if decomp is not None:
                        chunk = decomp.decompress(chunk)
                    out.write(chunk)
                    written += len(chunk)
                    if size and written >= next_report:
                        logger.info(
                            "  %s / %s (%.0f%%)",
                            human_bytes(written),
                            human_bytes(size),
                            100.0 * written / size,
                        )
                        next_report = written + _PROGRESS_STEP
                if decomp is not None:
                    out.write(decomp.flush())
            proc.stdout.close()
            returncode = proc.wait()
            errf.seek(0)
            stderr = errf.read().decode("utf-8", "replace").strip()

        if returncode != 0:
            raise RemoteError(
                f"Fetching {host}:{remote_path} failed (exit {returncode}): {stderr}"
            )
        actual = partial.stat().st_size
        if actual != size:
            raise RemoteError(
                f"{host}:{remote_path} is {actual} bytes but was {size} bytes a "
                "moment earlier -- it looks like it changed mid-transfer. Retry."
            )
        os.replace(partial, dest)
    except zlib.error as e:
        partial.unlink(missing_ok=True)
        raise RemoteError(
            f"Corrupt data while fetching {host}:{remote_path}: {e}"
        ) from e
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    return wire


def _is_fresh(dest: Path, mtime: int, size: int) -> bool:
    """Whether the cache entry still matches the remote file.

    Works without a sidecar precisely because the entry is a verbatim copy whose
    mtime we set to the remote one after fetching.
    """
    if not dest.is_file():
        return False
    st = dest.stat()
    return st.st_size == size and int(st.st_mtime) == mtime


def fetch_remote(
    host: str, remote_path: str, *, refresh: bool = False, offline: bool = False
) -> Path:
    """Return a local cached copy of `host:remote_path`, fetching it if stale."""
    dest = cache_entry_path(host, remote_path)
    spec = f"{host}:{remote_path}"

    if offline:
        if dest.is_file():
            logger.info("Using cached copy of %s (offline).", spec)
            return dest
        raise RemoteError(
            f"--offline was given but there is no cached copy of {spec} "
            f"(expected at {dest})."
        )

    if shutil.which("ssh") is None:
        raise RemoteError(
            "'ssh' was not found on PATH, so remote files cannot be fetched."
        )

    mtime, size, has_gzip = _probe(host, remote_path)
    if not refresh and _is_fresh(dest, mtime, size):
        logger.info("Using cached copy of %s (remote unchanged).", spec)
        return dest

    logger.info("Fetching %s (%s)...", spec, human_bytes(size))
    dest.parent.mkdir(parents=True, exist_ok=True)
    wire = _fetch(host, remote_path, dest, has_gzip, size)
    os.utime(dest, (mtime, mtime))

    ratio = f", {size / wire:.1f}x smaller" if wire and wire < size else ""
    logger.info(
        "Fetched %s over the wire (%s on disk%s). Cached at %s",
        human_bytes(wire),
        human_bytes(size),
        ratio,
        dest,
    )
    return dest


def resolve_input(spec: str, *, refresh: bool = False, offline: bool = False) -> Path:
    """Turn a CLI input spec into a local path, fetching it if it's `host:path`.

    Non-remote specs are returned as-is (including nonexistent ones) so callers
    keep reporting their own "file not found" errors.
    """
    if _local_exists(spec):
        return Path(spec)
    parsed = parse_remote_spec(spec)
    if parsed is None:
        return Path(spec)
    return fetch_remote(*parsed, refresh=refresh, offline=offline)
