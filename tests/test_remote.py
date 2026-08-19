"""Tests for `simview.remote` (scp-style 'host:path' inputs).

No test here talks to a real host: `_run_ssh` (the probe) and `subprocess.Popen`
(the fetch) are the two boundaries, and both are faked. What the fakes let us
pin down is the property the rest of the codebase depends on -- whatever
compression the transfer used, the cache entry is byte-identical to the source.
"""

import gzip
import io
import json
import os

import pytest

from simview import remote


def _scene_bytes(n: int = 200) -> bytes:
    """Compressible stand-in for a scene file (real ones are very redundant)."""
    return json.dumps({"model": {"i": list(range(n))}, "states": []}).encode()


class _FakePopen:
    """Stands in for the ssh subprocess of `remote._fetch`."""

    def __init__(self, payload, returncode=0, err=b"", argv_log=None):
        self._payload = payload
        self._returncode = returncode
        self._err = err
        self._argv_log = argv_log if argv_log is not None else []

    def __call__(self, argv, stdout=None, stderr=None):
        self._argv_log.append(argv)
        if stderr is not None:
            stderr.write(self._err)
        self.stdout = io.BytesIO(self._payload)
        return self

    def wait(self):
        return self._returncode


@pytest.fixture
def fake_ssh(monkeypatch, tmp_path):
    """Point the cache at tmp_path and pretend ssh exists."""
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.setattr(remote.shutil, "which", lambda name: "/usr/bin/ssh")


def _probe(monkeypatch, mtime, size, has_gzip=True):
    monkeypatch.setattr(
        remote,
        "_run_ssh",
        lambda host, command: f"{mtime} {size}\n{'GZIP' if has_gzip else 'NOGZIP'}\n",
    )


def _popen(monkeypatch, payload, **kwargs):
    fake = _FakePopen(payload, **kwargs)
    monkeypatch.setattr(remote.subprocess, "Popen", fake)
    return fake


# --------------------------------------------------------------------------
# spec parsing
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "spec,expected",
    [
        (
            "rci:~/projects/DRIFT/results/sim.json",
            ("rci", "~/projects/DRIFT/results/sim.json"),
        ),
        ("user@host.example.com:/abs/x.json", ("user@host.example.com", "/abs/x.json")),
        ("rci:relative/x.json", ("rci", "relative/x.json")),
        ("ssh://rci/home/me/x.json", ("rci", "/home/me/x.json")),
        ("ssh://me@rci/home/me/x.json", ("me@rci", "/home/me/x.json")),
        # Brackets are stripped: ssh(1) wants '::1', not '[::1]'.
        ("[::1]:/x.json", ("::1", "/x.json")),
        ("me@[::1]:/x.json", ("me@::1", "/x.json")),
    ],
)
def test_parse_remote_spec_accepts(spec, expected):
    assert remote.parse_remote_spec(spec) == expected


@pytest.mark.parametrize(
    "spec",
    [
        "scene.json",
        "./dir/scene.json",
        "/abs/scene.json",
        r"C:\scenes\x.json",  # one-char host is rejected, so Windows paths are safe
        "C:/scenes/x.json",
        "rci:",  # no path
        ":x.json",  # no host
        "bad host:x.json",
    ],
)
def test_parse_remote_spec_rejects(spec):
    assert remote.parse_remote_spec(spec) is None


@pytest.mark.parametrize(
    "spec", ["ssh://rci:2222/x.json", "ssh://rci", "ssh:///x.json"]
)
def test_parse_remote_spec_rejects_malformed_urls(spec):
    with pytest.raises(remote.RemoteError):
        remote.parse_remote_spec(spec)


def test_existing_local_file_wins_over_remote_syntax(tmp_path, monkeypatch):
    weird = tmp_path / "weird:name.json"
    weird.write_bytes(b"{}")
    monkeypatch.chdir(tmp_path)
    assert remote.is_remote_spec("weird:name.json") is False
    assert remote.resolve_input("weird:name.json").name == "weird:name.json"
    # ...but the same name with nothing on disk is treated as a remote spec.
    assert remote.is_remote_spec("weird:other.json") is True


# --------------------------------------------------------------------------
# quoting
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "path,expected",
    [
        ("~/results/sim.json", "~/results/sim.json"),
        ("~/dir with space/sim.json", "~/'dir with space/sim.json'"),
        ("~someone/sim.json", "~someone/sim.json"),
        ("/abs/a b.json", "'/abs/a b.json'"),
        ("relative/sim.json", "relative/sim.json"),
        # A tilde component that isn't a plain user name gets quoted wholesale.
        ("~evil$stuff/sim.json", "'~evil$stuff/sim.json'"),
        ("$(rm -rf /)", "'$(rm -rf /)'"),
    ],
)
def test_quote_remote_path(path, expected):
    assert remote.quote_remote_path(path) == expected


# --------------------------------------------------------------------------
# cache layout
# --------------------------------------------------------------------------


def test_cache_entry_keeps_basename_and_honours_xdg(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path))
    entry = remote.cache_entry_path("rci", "~/results/comparison.json")
    # merge_simulation_files labels batches by p.name, so this must stay readable.
    assert entry.name == "comparison.json"
    assert tmp_path in entry.parents
    assert entry == remote.cache_entry_path("rci", "~/results/comparison.json")
    # Same basename on a different host or path must not collide.
    assert (
        entry.parent
        != remote.cache_entry_path("other", "~/results/comparison.json").parent
    )
    assert (
        entry.parent != remote.cache_entry_path("rci", "~/runs/comparison.json").parent
    )


# --------------------------------------------------------------------------
# transfer modes -- all must round-trip byte-identically
# --------------------------------------------------------------------------


def test_plain_json_is_gzipped_on_the_wire(monkeypatch, fake_ssh):
    payload = _scene_bytes()
    _probe(monkeypatch, mtime=1700000000, size=len(payload))
    fake = _popen(monkeypatch, gzip.compress(payload))

    dest = remote.fetch_remote("rci", "~/sim.json")

    assert dest.read_bytes() == payload
    (argv,) = fake._argv_log
    assert argv[-1] == "gzip -c -1 -- ~/sim.json"
    assert "-C" not in argv  # no double compression


def test_already_gzipped_file_is_streamed_verbatim(monkeypatch, fake_ssh):
    payload = gzip.compress(_scene_bytes())
    _probe(monkeypatch, mtime=1700000000, size=len(payload))
    fake = _popen(monkeypatch, payload)

    dest = remote.fetch_remote("rci", "~/sim.json.gz")

    assert dest.read_bytes() == payload
    (argv,) = fake._argv_log
    assert argv[-1] == "cat -- ~/sim.json.gz"
    assert "-C" not in argv  # re-compressing compressed data is pure waste


def test_falls_back_to_transport_compression_without_remote_gzip(monkeypatch, fake_ssh):
    payload = _scene_bytes()
    _probe(monkeypatch, mtime=1700000000, size=len(payload), has_gzip=False)
    fake = _popen(monkeypatch, payload)

    dest = remote.fetch_remote("rci", "~/sim.json")

    assert dest.read_bytes() == payload
    (argv,) = fake._argv_log
    assert argv[-1] == "cat -- ~/sim.json"
    assert "-C" in argv


def test_gzipped_content_under_a_json_name_survives_double_compression(
    monkeypatch, fake_ssh
):
    # The remote file is gzip data but isn't named .gz, so it goes over the wire
    # double-compressed; unwrapping exactly one layer must restore it exactly.
    payload = gzip.compress(_scene_bytes())
    _probe(monkeypatch, mtime=1700000000, size=len(payload))
    _popen(monkeypatch, gzip.compress(payload))

    dest = remote.fetch_remote("rci", "~/sim.json")

    assert dest.read_bytes() == payload


def test_cache_entry_carries_the_remote_mtime_and_size(monkeypatch, fake_ssh):
    payload = _scene_bytes()
    _probe(monkeypatch, mtime=1700000000, size=len(payload))
    _popen(monkeypatch, gzip.compress(payload))

    dest = remote.fetch_remote("rci", "~/sim.json")

    st = dest.stat()
    assert int(st.st_mtime) == 1700000000
    assert st.st_size == len(payload)


# --------------------------------------------------------------------------
# failure handling
# --------------------------------------------------------------------------


def test_truncated_transfer_is_rejected_and_leaves_nothing_behind(
    monkeypatch, fake_ssh
):
    payload = _scene_bytes()
    _probe(monkeypatch, mtime=1700000000, size=len(payload))
    _popen(monkeypatch, gzip.compress(payload[:50]))

    with pytest.raises(remote.RemoteError, match="mid-transfer"):
        remote.fetch_remote("rci", "~/sim.json")

    entry = remote.cache_entry_path("rci", "~/sim.json")
    assert not entry.exists()
    assert not entry.with_name(entry.name + ".partial").exists()


def test_failed_ssh_leaves_no_partial_file(monkeypatch, fake_ssh):
    _probe(monkeypatch, mtime=1700000000, size=999)
    _popen(monkeypatch, b"", returncode=255, err=b"ssh: Could not resolve hostname rci")

    with pytest.raises(remote.RemoteError, match="Could not resolve hostname"):
        remote.fetch_remote("rci", "~/sim.json")

    entry = remote.cache_entry_path("rci", "~/sim.json")
    assert not entry.with_name(entry.name + ".partial").exists()


def test_corrupt_gzip_stream_is_reported(monkeypatch, fake_ssh):
    _probe(monkeypatch, mtime=1700000000, size=100)
    _popen(monkeypatch, b"not gzip data at all")

    with pytest.raises(remote.RemoteError, match="Corrupt data"):
        remote.fetch_remote("rci", "~/sim.json")


def test_missing_remote_file_is_reported(monkeypatch, fake_ssh):
    def boom(host, command):
        raise remote.RemoteError("ssh rci failed (exit 3): no such file")

    monkeypatch.setattr(remote, "_run_ssh", boom)
    with pytest.raises(remote.RemoteError, match="no such file"):
        remote.fetch_remote("rci", "~/nope.json")


def test_missing_ssh_binary_is_reported(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.setattr(remote.shutil, "which", lambda name: None)
    with pytest.raises(remote.RemoteError, match="'ssh' was not found"):
        remote.fetch_remote("rci", "~/sim.json")


def test_unparseable_stat_output_is_reported(monkeypatch, fake_ssh):
    monkeypatch.setattr(remote, "_run_ssh", lambda host, command: "??? ??? \nGZIP\n")
    with pytest.raises(remote.RemoteError, match="Could not parse"):
        remote.fetch_remote("rci", "~/sim.json")


# --------------------------------------------------------------------------
# caching / freshness
# --------------------------------------------------------------------------


def _seed_cache(payload: bytes, mtime: int) -> "os.PathLike[str]":
    entry = remote.cache_entry_path("rci", "~/sim.json")
    entry.parent.mkdir(parents=True, exist_ok=True)
    entry.write_bytes(payload)
    os.utime(entry, (mtime, mtime))
    return entry


def _refuse_to_fetch(monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("should not have re-fetched")

    monkeypatch.setattr(remote, "_fetch", boom)


def test_unchanged_remote_file_is_served_from_cache(monkeypatch, fake_ssh, caplog):
    payload = _scene_bytes()
    entry = _seed_cache(payload, 1700000000)
    _probe(monkeypatch, mtime=1700000000, size=len(payload))
    _refuse_to_fetch(monkeypatch)

    with caplog.at_level("INFO", logger="simview.remote"):
        assert remote.fetch_remote("rci", "~/sim.json") == entry
    assert "remote unchanged" in caplog.text


@pytest.mark.parametrize("mtime,size_delta", [(1700009999, 0), (1700000000, 7)])
def test_changed_remote_file_is_refetched(monkeypatch, fake_ssh, mtime, size_delta):
    _seed_cache(b"stale", 1700000000)
    payload = _scene_bytes()
    _probe(monkeypatch, mtime=mtime, size=len(payload) + size_delta)
    _popen(monkeypatch, gzip.compress(payload))

    if size_delta:  # probe size disagrees with what arrives -> mid-transfer change
        with pytest.raises(remote.RemoteError):
            remote.fetch_remote("rci", "~/sim.json")
        return
    assert remote.fetch_remote("rci", "~/sim.json").read_bytes() == payload


def test_refresh_refetches_even_when_fresh(monkeypatch, fake_ssh):
    payload = _scene_bytes()
    _seed_cache(payload, 1700000000)
    _probe(monkeypatch, mtime=1700000000, size=len(payload))
    fake = _popen(monkeypatch, gzip.compress(payload))

    remote.fetch_remote("rci", "~/sim.json", refresh=True)

    assert len(fake._argv_log) == 1


def test_offline_uses_the_cache_without_contacting_the_host(monkeypatch, fake_ssh):
    payload = _scene_bytes()
    entry = _seed_cache(payload, 1700000000)

    def boom(host, command):
        raise AssertionError("offline must not run ssh")

    monkeypatch.setattr(remote, "_run_ssh", boom)
    assert remote.fetch_remote("rci", "~/sim.json", offline=True) == entry


def test_offline_without_a_cached_copy_fails(monkeypatch, fake_ssh):
    with pytest.raises(remote.RemoteError, match="no cached copy"):
        remote.fetch_remote("rci", "~/sim.json", offline=True)


def test_resolve_input_passes_local_paths_through(tmp_path):
    missing = tmp_path / "nope.json"
    # Not remote, so it comes back untouched for the caller to complain about.
    assert remote.resolve_input(str(missing)) == missing
