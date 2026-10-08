"""Tests for simview.utils (torch-free helpers usable in viewing-only installs)."""

import gzip
import json
import socket

import pytest

from simview.utils import find_free_port, read_maybe_gzipped_bytes


def test_read_maybe_gzipped_bytes_plain_json(tmp_path):
    path = tmp_path / "plain.json"
    path.write_text('{"a": 1}')
    assert read_maybe_gzipped_bytes(path) == b'{"a": 1}'


def test_read_maybe_gzipped_bytes_gzip(tmp_path):
    path = tmp_path / "compressed.json.gz"
    payload = json.dumps({"a": 1}).encode()
    path.write_bytes(gzip.compress(payload))
    assert read_maybe_gzipped_bytes(path) == payload


def test_read_maybe_gzipped_bytes_detects_by_magic_not_extension(tmp_path):
    # No .gz suffix, but the content is gzip-compressed -- detection must still work.
    path = tmp_path / "no_gz_suffix.json"
    payload = json.dumps({"a": 1}).encode()
    path.write_bytes(gzip.compress(payload))
    assert read_maybe_gzipped_bytes(path) == payload


def test_find_free_port_returns_base_port_when_free():
    # Bind and release a port first to get one that's very likely free, without
    # hardcoding a port number that might already be in use on the test runner.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    assert find_free_port("127.0.0.1", port) == port


def test_find_free_port_supports_ipv6_hosts():
    if not socket.has_ipv6:
        pytest.skip("no IPv6")
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as s:
            s.bind(("::1", 0))
            port = s.getsockname()[1]
    except OSError:
        pytest.skip("IPv6 loopback not available")
    assert find_free_port("::1", port) == port


def test_find_free_port_skips_occupied_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        # Socket is still bound (held open) inside this `with` block, so
        # find_free_port must skip it and return the next one.
        found = find_free_port("127.0.0.1", port)
        assert found != port
        assert found > port


def test_find_free_port_raises_when_no_port_available_up_to_max(monkeypatch):
    # Bug B1: previously this looped forever once base_port exceeded 65535.
    # Force every bind attempt to fail so find_free_port must exhaust the
    # range and raise instead of looping indefinitely.
    import simview.utils as utils_module

    class _AlwaysBusySocket:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def bind(self, *args, **kwargs):
            raise OSError("port busy")

    monkeypatch.setattr(
        utils_module.socket, "socket", lambda *a, **k: _AlwaysBusySocket()
    )

    with pytest.raises(OSError, match="No free port"):
        find_free_port("127.0.0.1", utils_module._MAX_PORT - 2)


def test_load_scene_rejects_a_states_dict_that_is_not_columnar(tmp_path):
    from simview.utils import load_scene

    path = tmp_path / "scene.json"
    path.write_text(json.dumps({"model": {"simBatches": 1}, "states": {"version": 3}}))
    with pytest.raises(ValueError, match="columnar"):
        load_scene(path)
