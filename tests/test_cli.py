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


def test_info_prints_text_summary_by_default(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(cli.sys, "argv", ["simview", "info", str(sim_file)])
    cli.main()

    out = capsys.readouterr().out
    assert "Model" in out
    assert "States" in out
    assert not out.startswith("{")


def test_info_json_flag_prints_valid_json(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(cli.sys, "argv", ["simview", "info", str(sim_file), "--json"])
    cli.main()

    summary = json.loads(capsys.readouterr().out)
    assert summary["model"]["batch_size"] == 2
    assert summary["states"]["frame_count"] == 3


def test_info_missing_file_errors(capsys, monkeypatch, tmp_path):
    missing = tmp_path / "does-not-exist.json"
    monkeypatch.setattr(cli.sys, "argv", ["simview", "info", str(missing)])
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "not found" in capsys.readouterr().err


def test_info_requires_exactly_one_path(capsys, monkeypatch, tmp_path):
    monkeypatch.setattr(cli.sys, "argv", ["simview", "info"])
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "exactly one file" in capsys.readouterr().err

    a, b = tmp_path / "a.json", tmp_path / "b.json"
    a.write_text("{}")
    b.write_text("{}")
    monkeypatch.setattr(cli.sys, "argv", ["simview", "info", str(a), str(b)])
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "exactly one file" in capsys.readouterr().err


def test_info_works_on_gzipped_scene(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file, compress=True)
    gz_file = sim_file.with_name(sim_file.name + ".gz")

    monkeypatch.setattr(cli.sys, "argv", ["simview", "info", str(gz_file), "--json"])
    cli.main()

    summary = json.loads(capsys.readouterr().out)
    assert summary["file"]["gzipped"] is True
    assert summary["states"]["frame_count"] == 3


def test_terrain_point_prints_text_by_default(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys, "argv", ["simview", "terrain", str(sim_file), "--point", "0", "0"]
    )
    cli.main()

    out = capsys.readouterr().out
    assert "height:" in out
    assert "friction:" in out
    assert not out.startswith("{")


def test_terrain_point_json_flag_prints_valid_json(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "terrain", str(sim_file), "--point", "0", "0", "--json"],
    )
    cli.main()

    result = json.loads(capsys.readouterr().out)
    assert result["layers"]["height"]["value"] == pytest.approx(0.0)
    assert result["layers"]["friction"]["value"] == pytest.approx(0.5)


def test_terrain_area_whole_extent_and_subbox(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "terrain", str(sim_file), "--area", "--json"],
    )
    cli.main()
    whole = json.loads(capsys.readouterr().out)
    assert len(whole["x_coords"]) == 4  # build_scene's terrain resolution

    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "terrain", str(sim_file), "--area", "-5", "0", "-5", "0", "--json"],
    )
    cli.main()
    sub = json.loads(capsys.readouterr().out)
    assert len(sub["x_coords"]) < len(whole["x_coords"])


def test_terrain_point_and_area_are_mutually_exclusive(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "terrain", str(sim_file), "--point", "0", "0", "--area"],
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "exactly one of --point or --area" in capsys.readouterr().err

    monkeypatch.setattr(cli.sys, "argv", ["simview", "terrain", str(sim_file)])
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "exactly one of --point or --area" in capsys.readouterr().err


def test_terrain_missing_file_errors(capsys, monkeypatch, tmp_path):
    missing = tmp_path / "does-not-exist.json"
    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "terrain", str(missing), "--point", "0", "0"],
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "not found" in capsys.readouterr().err


def test_diff_prints_text_summary_by_default(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys, "argv", ["simview", "diff", str(sim_file), "--batches", "0", "1"]
    )
    cli.main()

    out = capsys.readouterr().out
    assert "Box" in out
    assert "pos_err" in out
    assert not out.startswith("{")


def test_diff_json_flag_prints_valid_json(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "diff", str(sim_file), "--batches", "0", "1", "--json"],
    )
    cli.main()

    result = json.loads(capsys.readouterr().out)
    assert result["bodies"]["Box"]["summary"]["position_error"][
        "mean"
    ] == pytest.approx(0.0)


def test_diff_requires_batches_flag(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(cli.sys, "argv", ["simview", "diff", str(sim_file)])
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "requires --batches" in capsys.readouterr().err


def test_diff_missing_file_errors(capsys, monkeypatch, tmp_path):
    missing = tmp_path / "does-not-exist.json"
    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "diff", str(missing), "--batches", "0", "1"],
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "not found" in capsys.readouterr().err


def test_diff_requires_exactly_one_path(capsys, monkeypatch, tmp_path):
    monkeypatch.setattr(cli.sys, "argv", ["simview", "diff"])
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "exactly one file" in capsys.readouterr().err


def test_diff_body_flag_filters_to_one_body(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        [
            "simview",
            "diff",
            str(sim_file),
            "--batches",
            "0",
            "1",
            "--body",
            "Box",
            "--json",
        ],
    )
    cli.main()

    result = json.loads(capsys.readouterr().out)
    assert set(result["bodies"]) == {"Box"}


def test_diff_single_batch_scene_errors(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys, "argv", ["simview", "diff", str(sim_file), "--batches", "0", "1"]
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "need at least 2" in capsys.readouterr().err


def test_terrain_batches_flag_switches_to_point_diff_mode(
    capsys, monkeypatch, tmp_path
):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        [
            "simview",
            "terrain",
            str(sim_file),
            "--point",
            "0",
            "0",
            "--batches",
            "0",
            "1",
            "--json",
        ],
    )
    cli.main()

    result = json.loads(capsys.readouterr().out)
    assert "value_a" in result["layers"]["height"]
    assert "value_b" in result["layers"]["height"]
    assert "delta" in result["layers"]["height"]
    assert "batch" not in result


def test_terrain_batches_flag_switches_to_area_diff_mode(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        [
            "simview",
            "terrain",
            str(sim_file),
            "--area",
            "--batches",
            "0",
            "1",
            "--json",
        ],
    )
    cli.main()

    result = json.loads(capsys.readouterr().out)
    assert "value_a" in result["layers"]["height"]
    assert "batch" not in result


def test_terrain_batches_takes_precedence_over_batch_flag(
    capsys, monkeypatch, tmp_path
):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        [
            "simview",
            "terrain",
            str(sim_file),
            "--point",
            "0",
            "0",
            "--batch",
            "1",
            "--batches",
            "0",
            "1",
            "--json",
        ],
    )
    cli.main()

    result = json.loads(capsys.readouterr().out)
    assert "batch_a" in result
    assert "batch" not in result


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
