"""Tests for the simview CLI (gameplan item 13: --version/--host/--port/
--no-browser/--save-merged)."""

import gzip
import json

import pytest

pytest.importorskip("torch")

from conftest import build_scene

import simview.__main__ as cli


def _fail_if_called(*args, **kwargs):
    raise AssertionError("server should not be started when --save-merged is used")


def test_version_matches_package_metadata(capsys, monkeypatch):
    monkeypatch.setattr(cli.sys, "argv", ["simview", "--version"])
    cli.main()
    out = capsys.readouterr().out.strip()
    assert out == cli._package_version()


def test_no_args_prints_help_and_exits(capsys, monkeypatch):
    monkeypatch.setattr(cli.sys, "argv", ["simview"])
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "usage" in capsys.readouterr().out.lower()


def test_clear_still_works(monkeypatch):
    monkeypatch.setattr(cli.sys, "argv", ["simview", "clear"])
    called = []
    monkeypatch.setattr(cli, "clear_cache", lambda: called.append(True))
    cli.main()
    assert called == [True]


def test_missing_file_errors(capsys, monkeypatch, tmp_path):
    missing = tmp_path / "does-not-exist.json"
    monkeypatch.setattr(cli.sys, "argv", ["simview", str(missing)])
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "not found" in capsys.readouterr().err


def test_single_file_starts_server_with_host_port_and_browser_flag(
    monkeypatch, tmp_path
):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    calls = []
    monkeypatch.setattr(
        cli.SimViewServer, "start", staticmethod(lambda **kw: calls.append(kw))
    )
    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", str(sim_file), "--host", "0.0.0.0", "--port", "1234"],
    )
    cli.main()

    assert len(calls) == 1
    kwargs = calls[0]
    assert kwargs["sim_path"] == sim_file
    assert kwargs["host"] == "0.0.0.0"
    assert kwargs["preferred_port"] == 1234
    assert kwargs["open_browser"] is True  # default: browser opens unless --no-browser


def test_no_browser_flag_disables_auto_open(monkeypatch, tmp_path):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    calls = []
    monkeypatch.setattr(
        cli.SimViewServer, "start", staticmethod(lambda **kw: calls.append(kw))
    )
    monkeypatch.setattr(cli.sys, "argv", ["simview", str(sim_file), "--no-browser"])
    cli.main()

    assert calls[0]["open_browser"] is False


def test_multi_file_passes_list_to_server(monkeypatch, tmp_path):
    scene_a = build_scene(batch_size=1)
    scene_b = build_scene(batch_size=1)
    path_a, path_b = tmp_path / "a.json", tmp_path / "b.json"
    scene_a.save(path_a)
    scene_b.save(path_b)

    calls = []
    monkeypatch.setattr(
        cli.SimViewServer, "start", staticmethod(lambda **kw: calls.append(kw))
    )
    monkeypatch.setattr(cli.sys, "argv", ["simview", str(path_a), str(path_b)])
    cli.main()

    assert calls[0]["sim_path"] == [path_a, path_b]


def test_save_merged_writes_json_without_starting_server(monkeypatch, tmp_path):
    scene_a = build_scene(batch_size=1)
    scene_b = build_scene(batch_size=2)
    path_a, path_b = tmp_path / "a.json", tmp_path / "b.json"
    scene_a.save(path_a)
    scene_b.save(path_b)
    out_path = tmp_path / "merged.json"

    monkeypatch.setattr(cli.SimViewServer, "start", staticmethod(_fail_if_called))
    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", str(path_a), str(path_b), "--save-merged", str(out_path)],
    )
    cli.main()

    assert out_path.is_file()
    merged = json.loads(out_path.read_text())
    assert merged["model"]["simBatches"] == 3


def test_save_merged_gzips_when_path_ends_in_gz(monkeypatch, tmp_path):
    scene_a = build_scene(batch_size=1)
    scene_b = build_scene(batch_size=1)
    path_a, path_b = tmp_path / "a.json", tmp_path / "b.json"
    scene_a.save(path_a)
    scene_b.save(path_b)
    out_path = tmp_path / "merged.json.gz"

    monkeypatch.setattr(cli.SimViewServer, "start", staticmethod(_fail_if_called))
    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", str(path_a), str(path_b), "--save-merged", str(out_path)],
    )
    cli.main()

    assert out_path.is_file()
    raw = out_path.read_bytes()
    assert raw[:2] == b"\x1f\x8b"  # gzip magic
    merged = json.loads(gzip.decompress(raw))
    assert merged["model"]["simBatches"] == 2


def test_save_merged_requires_at_least_two_inputs(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)
    out_path = tmp_path / "merged.json"

    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", str(sim_file), "--save-merged", str(out_path)],
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "at least 2" in capsys.readouterr().err
    assert not out_path.exists()
