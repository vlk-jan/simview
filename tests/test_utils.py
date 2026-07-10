"""Tests for simview.utils (torch-free helpers usable in viewing-only installs)."""

import gzip
import json

from simview.utils import read_maybe_gzipped_bytes


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
