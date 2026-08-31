"""Tests for the simview CLI (gameplan item 13: --version/--host/--port/
--no-browser/--save-merged)."""

import base64
import csv
import gzip
import io
import json
import struct

import pytest

pytest.importorskip("torch")

from conftest import build_scene

import simview.__main__ as cli


def _fail_if_called(*args, **kwargs):
    raise AssertionError("server should not be started when --save-merged is used")


def _blob(values: list) -> str:
    return (
        "__b64__" + base64.b64encode(struct.pack(f"<{len(values)}f", *values)).decode()
    )


def _write_raw_scene(path, model: dict, states: list) -> None:
    """Write a hand-built scene JSON straight to disk, bypassing
    SimulationScene -- for --along-body tests that need terrain/trajectory
    shapes build_scene() doesn't produce (e.g. diverging per-batch
    trajectories)."""
    path.write_text(json.dumps({"model": model, "states": states}))


def _along_body_diff_scene(path) -> None:
    """Two batches whose 'Box' trajectory and terrain both diverge: batch 1's
    height grid is 2x batch 0's, and batch 1's path is the *reverse* of
    batch 0's. Used to prove --along-body --batches samples along batch A's
    path end-to-end through the CLI -- if it wrongly used batch B's
    (reversed) path instead, the sampled x positions and deltas below would
    come out reversed too."""
    grid_a = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
    grid_b = [v * 2 for v in grid_a]
    terrain = {
        "dimensions": {"sizeX": 2.0, "sizeY": 2.0, "resolutionX": 3, "resolutionY": 3},
        "bounds": {
            "minX": 0.0,
            "maxX": 2.0,
            "minY": 0.0,
            "maxY": 2.0,
            "minZ": 0.0,
            "maxZ": 16.0,
        },
        "heightData": _blob(grid_a + grid_b),
        "normals": [[[0, 0, 1]] * 3] * 3,
        "isSingleton": False,
    }
    model = {"simBatches": 2, "terrain": terrain}

    def _row(x):
        return [x, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]

    states = []
    for t in range(3):
        row_a = _row(float(t))
        row_b = _row(float(2 - t))
        states.append(
            {
                "time": t * 0.1,
                "bodies": [{"name": "Box", "bodyTransform": _blob(row_a + row_b)}],
            }
        )
    _write_raw_scene(path, model, states)


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
    assert "exactly one of --point, --area, or --along-body" in capsys.readouterr().err

    monkeypatch.setattr(cli.sys, "argv", ["simview", "terrain", str(sim_file)])
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "exactly one of --point, --area, or --along-body" in capsys.readouterr().err

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
            "--along-body",
            "Box",
        ],
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "exactly one of --point, --area, or --along-body" in capsys.readouterr().err


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


def test_terrain_along_body_prints_text_by_default(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "terrain", str(sim_file), "--along-body", "Box"],
    )
    cli.main()

    out = capsys.readouterr().out
    assert "Box" in out
    assert "height" in out
    assert not out.startswith("{")


def test_terrain_along_body_json_flag_prints_valid_json(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "terrain", str(sim_file), "--along-body", "Box", "--json"],
    )
    cli.main()

    result = json.loads(capsys.readouterr().out)
    assert result["body"] == "Box"
    assert result["frame_indices"] == [0, 1, 2]
    assert result["layers"]["height"]["values"] == pytest.approx([0.0, 0.0, 0.0])
    assert result["layers"]["friction"]["summary"]["mean"] == pytest.approx(0.5)


def test_terrain_along_body_csv_flag_produces_parseable_csv(
    capsys, monkeypatch, tmp_path
):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "terrain", str(sim_file), "--along-body", "Box", "--csv"],
    )
    cli.main()

    rows = list(csv.reader(io.StringIO(capsys.readouterr().out)))
    assert rows[0][:4] == ["frame", "time", "x", "y"]
    assert len(rows) - 1 == 3  # build_scene() has 3 states


def test_terrain_along_body_every_flag_subsamples(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        [
            "simview",
            "terrain",
            str(sim_file),
            "--along-body",
            "Box",
            "--every",
            "2",
            "--json",
        ],
    )
    cli.main()

    result = json.loads(capsys.readouterr().out)
    assert result["frame_indices"] == [0, 2]


def test_terrain_along_body_not_found_errors(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "terrain", str(sim_file), "--along-body", "Nope"],
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "not found" in capsys.readouterr().err


def test_terrain_along_body_ambiguous_errors(capsys, monkeypatch, tmp_path):
    terrain = {
        "dimensions": {"sizeX": 2.0, "sizeY": 2.0, "resolutionX": 3, "resolutionY": 3},
        "bounds": {
            "minX": 0.0,
            "maxX": 2.0,
            "minY": 0.0,
            "maxY": 2.0,
            "minZ": 0.0,
            "maxZ": 1.0,
        },
        "heightData": _blob([0.0] * 9),
        "normals": [[[0, 0, 1]] * 3] * 3,
        "isSingleton": True,
    }
    model = {"simBatches": 1, "terrain": terrain}
    row = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]
    states = [
        {
            "time": 0.0,
            "bodies": [
                {"name": ["A", "B"], "bodyTransform": row},
                {"name": ["B", "C"], "bodyTransform": row},
            ],
        }
    ]
    sim_file = tmp_path / "sim.json"
    _write_raw_scene(sim_file, model, states)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "terrain", str(sim_file), "--along-body", "B"],
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "ambiguous" in capsys.readouterr().err


def test_terrain_along_body_batches_diff_samples_along_batch_a_path(
    capsys, monkeypatch, tmp_path
):
    sim_file = tmp_path / "sim.json"
    _along_body_diff_scene(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        [
            "simview",
            "terrain",
            str(sim_file),
            "--along-body",
            "Box",
            "--batches",
            "0",
            "1",
            "--json",
        ],
    )
    cli.main()

    result = json.loads(capsys.readouterr().out)
    # Batch a's path is x=[0, 1, 2]; batch b's (unused) path is the reverse.
    assert result["x"] == pytest.approx([0.0, 1.0, 2.0])
    layer = result["layers"]["height"]
    assert layer["value_a"] == pytest.approx([0.0, 1.0, 2.0])
    assert layer["value_b"] == pytest.approx([0.0, 2.0, 4.0])
    assert layer["delta"] == pytest.approx([0.0, 1.0, 2.0])


def test_terrain_along_body_batches_diff_csv_flag(capsys, monkeypatch, tmp_path):
    sim_file = tmp_path / "sim.json"
    _along_body_diff_scene(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        [
            "simview",
            "terrain",
            str(sim_file),
            "--along-body",
            "Box",
            "--batches",
            "0",
            "1",
            "--csv",
        ],
    )
    cli.main()

    rows = list(csv.reader(io.StringIO(capsys.readouterr().out)))
    assert rows[0] == [
        "frame",
        "time",
        "x",
        "y",
        "height_a",
        "height_b",
        "height_delta",
    ]
    assert len(rows) - 1 == 3


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


def test_diff_per_axis_flag_adds_axis_fields_to_json(capsys, monkeypatch, tmp_path):
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
            "--per-axis",
            "--json",
        ],
    )
    cli.main()

    result = json.loads(capsys.readouterr().out)
    assert result["per_axis"] is True
    assert "err_x" in result["bodies"]["Box"]


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


def test_diff_fail_on_exceed_exits_2_when_threshold_exceeded(
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
            "diff",
            str(sim_file),
            "--batches",
            "0",
            "1",
            # Position error is always >= 0, so a negative threshold is
            # guaranteed to be exceeded on frame 0 without needing a scene
            # with diverging batch trajectories.
            "--pos-threshold",
            "-1",
            "--fail-on-exceed",
        ],
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 2
    assert "pos_err" in capsys.readouterr().out  # normal output still printed


def test_diff_fail_on_exceed_exits_0_when_within_threshold(monkeypatch, tmp_path):
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
            "--pos-threshold",
            "1000",
            "--fail-on-exceed",
        ],
    )
    cli.main()  # must not raise SystemExit


def test_diff_fail_on_exceed_requires_a_threshold(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "diff", str(sim_file), "--batches", "0", "1", "--fail-on-exceed"],
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "requires --pos-threshold" in capsys.readouterr().err


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


def test_diff_csv_flag_produces_parseable_csv(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "diff", str(sim_file), "--batches", "0", "1", "--csv"],
    )
    cli.main()

    rows = list(csv.reader(io.StringIO(capsys.readouterr().out)))
    assert rows[0] == [
        "body",
        "frame",
        "time",
        "position_error",
        "orientation_error_deg",
    ]
    assert len(rows) - 1 == 3  # build_scene() has 3 states


def test_terrain_area_csv_flag_produces_parseable_csv(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "terrain", str(sim_file), "--area", "--csv"],
    )
    cli.main()

    rows = list(csv.reader(io.StringIO(capsys.readouterr().out)))
    assert rows[0][:2] == ["x", "y"]
    assert len(rows) > 1


def test_terrain_point_batches_csv_flag_produces_parseable_csv(
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
            "--csv",
        ],
    )
    cli.main()

    rows = list(csv.reader(io.StringIO(capsys.readouterr().out)))
    assert rows[0] == ["layer", "value_a", "value_b", "delta", "clamped"]


def test_json_and_csv_together_errors(capsys, monkeypatch, tmp_path):
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
            "--json",
            "--csv",
        ],
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "mutually exclusive" in capsys.readouterr().err


def test_render_requires_output_flag(capsys, monkeypatch, tmp_path):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    monkeypatch.setattr(cli.sys, "argv", ["simview", "render", str(sim_file)])
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "requires --output" in capsys.readouterr().err


def test_render_missing_file_errors(capsys, monkeypatch, tmp_path):
    missing = tmp_path / "does-not-exist.json"
    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "render", str(missing), "--output", str(tmp_path / "out.png")],
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "not found" in capsys.readouterr().err


def test_render_requires_exactly_one_path(capsys, monkeypatch, tmp_path):
    monkeypatch.setattr(
        cli.sys, "argv", ["simview", "render", "--output", str(tmp_path / "out.png")]
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "requires exactly one file" in capsys.readouterr().err


def test_render_reports_missing_playwright_cleanly(capsys, monkeypatch, tmp_path):
    """Without the 'render' extra installed, 'simview render' must fail with
    a clear install hint rather than a raw ModuleNotFoundError traceback --
    simulate that by making the lazy import fail, regardless of whether
    playwright actually happens to be installed in the test environment."""
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)
    out_path = tmp_path / "out.png"

    import simview.render as render_mod

    def _raise_missing_playwright(*args, **kwargs):
        raise ImportError("'simview render' needs the 'playwright' package")

    monkeypatch.setattr(render_mod, "render_screenshot", _raise_missing_playwright)
    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "render", str(sim_file), "--output", str(out_path)],
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "playwright" in capsys.readouterr().err
    assert not out_path.exists()


def test_render_creates_png_file(monkeypatch, tmp_path):
    pytest.importorskip("playwright")
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)
    out_path = tmp_path / "out.png"

    monkeypatch.setattr(
        cli.sys,
        "argv",
        [
            "simview",
            "render",
            str(sim_file),
            "--output",
            str(out_path),
            # A distinct, unlikely-to-collide port -- --port 0 doesn't mean
            # "let the OS pick" here (find_free_port would just echo back 0
            # unchanged; see simview/utils.py), so pick a fixed one instead.
            "--port",
            "18420",
        ],
    )
    cli.main()

    assert out_path.exists()
    assert out_path.stat().st_size > 1024


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


# --------------------------------------------------------------------------
# remote 'host:path' inputs
#
# The ssh boundary is faked (simview.remote has its own tests for that); what
# matters here is that every CLI branch resolves a remote spec and that
# everything downstream still receives an ordinary local Path.
# --------------------------------------------------------------------------


@pytest.fixture
def fake_remote(monkeypatch, tmp_path):
    """Serve 'rci:~/sim.json' from a real scene file in a fake cache dir."""
    from simview import remote

    source = tmp_path / "remote_sim.json"
    build_scene(batch_size=2).save(source)
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    fetched = []

    def fake_fetch_remote(host, remote_path, *, refresh=False, offline=False):
        fetched.append((host, remote_path, refresh, offline))
        dest = remote.cache_entry_path(host, remote_path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(source.read_bytes())
        return dest

    monkeypatch.setattr(remote, "fetch_remote", fake_fetch_remote)
    return fetched


def test_remote_spec_reaches_the_server_as_a_local_path(monkeypatch, fake_remote):
    calls = []
    monkeypatch.setattr(
        cli.SimViewServer, "start", staticmethod(lambda **kw: calls.append(kw))
    )
    monkeypatch.setattr(cli.sys, "argv", ["simview", "rci:~/sim.json"])
    cli.main()

    assert fake_remote == [("rci", "~/sim.json", False, False)]
    (kwargs,) = calls
    sim_path = kwargs["sim_path"]
    assert sim_path.is_file()
    # The remote basename survives, because merge labels batches with it.
    assert sim_path.name == "sim.json"


def test_mixed_local_and_remote_inputs_are_merged(monkeypatch, tmp_path, fake_remote):
    local = tmp_path / "local.json"
    build_scene(batch_size=1).save(local)
    calls = []
    monkeypatch.setattr(
        cli.SimViewServer, "start", staticmethod(lambda **kw: calls.append(kw))
    )
    monkeypatch.setattr(cli.sys, "argv", ["simview", str(local), "rci:~/sim.json"])
    cli.main()

    (kwargs,) = calls
    paths = kwargs["sim_path"]
    assert [p.name for p in paths] == ["local.json", "sim.json"]
    assert all(p.is_file() for p in paths)


def test_refresh_and_offline_are_forwarded(monkeypatch, fake_remote):
    monkeypatch.setattr(cli.SimViewServer, "start", staticmethod(lambda **kw: None))
    monkeypatch.setattr(
        cli.sys, "argv", ["simview", "rci:~/sim.json", "--refresh", "--offline"]
    )
    cli.main()
    assert fake_remote == [("rci", "~/sim.json", True, True)]


@pytest.mark.parametrize(
    "argv,expected",
    [
        (["simview", "info", "rci:~/sim.json"], "Bodies"),
        (["simview", "diff", "rci:~/sim.json", "--batches", "0", "1"], "pos_err"),
        (["simview", "terrain", "rci:~/sim.json", "--point", "0", "0"], "height"),
    ],
)
def test_inspection_subcommands_accept_remote_specs(
    monkeypatch, capsys, fake_remote, argv, expected
):
    monkeypatch.setattr(cli.sys, "argv", argv)
    cli.main()

    assert fake_remote == [("rci", "~/sim.json", False, False)]
    assert expected.lower() in capsys.readouterr().out.lower()


def test_render_accepts_a_remote_spec(monkeypatch, tmp_path, fake_remote):
    seen = []
    monkeypatch.setattr(cli, "run_render", lambda path, args: seen.append(path))
    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", "render", "rci:~/sim.json", "--output", str(tmp_path / "f.png")],
    )
    cli.main()

    (path,) = seen
    assert path.is_file() and path.name == "sim.json"


def test_remote_fetch_failure_exits_cleanly(monkeypatch, capsys, tmp_path):
    from simview import remote

    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))

    def boom(host, remote_path, *, refresh=False, offline=False):
        raise remote.RemoteError("ssh rci failed (exit 255): host unreachable")

    monkeypatch.setattr(remote, "fetch_remote", boom)
    monkeypatch.setattr(cli.SimViewServer, "start", staticmethod(_fail_if_called))
    monkeypatch.setattr(cli.sys, "argv", ["simview", "rci:~/sim.json"])

    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "host unreachable" in capsys.readouterr().err


@pytest.mark.parametrize("flag", ["--save-merged", "--output"])
def test_remote_output_paths_are_rejected(monkeypatch, capsys, tmp_path, flag):
    scene_file = tmp_path / "sim.json"
    build_scene(batch_size=1).save(scene_file)
    monkeypatch.setattr(cli.SimViewServer, "start", staticmethod(_fail_if_called))
    monkeypatch.setattr(
        cli.sys, "argv", ["simview", str(scene_file), flag, "rci:~/out.json"]
    )

    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    err = capsys.readouterr().err
    assert flag in err and "only supported for inputs" in err


def test_clear_removes_the_remote_cache(monkeypatch, tmp_path, capsys):
    from simview import remote

    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    entry = remote.cache_entry_path("rci", "~/sim.json")
    entry.parent.mkdir(parents=True, exist_ok=True)
    entry.write_bytes(b"x" * 4096)

    monkeypatch.setattr(cli.sys, "argv", ["simview", "clear"])
    cli.main()

    assert not entry.exists()
    assert not remote.cache_dir().exists()
    assert "Cache cleared" in capsys.readouterr().err


# --------------------------------------------------------------------------
# 'file#batches' batch selection
# --------------------------------------------------------------------------


def test_batch_spec_merges_only_the_selected_batches(monkeypatch, tmp_path):
    scene_a = build_scene(batch_size=1)
    scene_b = build_scene(batch_size=3)
    path_a, path_b = tmp_path / "a.json", tmp_path / "b.json"
    scene_a.save(path_a)
    scene_b.save(path_b)
    out_path = tmp_path / "merged.json"

    monkeypatch.setattr(cli.SimViewServer, "start", staticmethod(_fail_if_called))
    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", str(path_a), f"{path_b}#1", "--save-merged", str(out_path)],
    )
    cli.main()

    merged = json.loads(out_path.read_text())
    assert merged["model"]["simBatches"] == 2
    assert merged["model"]["batchNames"] == ["a", "b[1]"]


def test_batch_spec_alone_subsets_a_single_file(monkeypatch, tmp_path):
    scene = build_scene(batch_size=3)
    path = tmp_path / "a.json"
    scene.save(path)
    out_path = tmp_path / "merged.json"

    monkeypatch.setattr(cli.SimViewServer, "start", staticmethod(_fail_if_called))
    monkeypatch.setattr(
        cli.sys, "argv", ["simview", f"{path}#0,2", "--save-merged", str(out_path)]
    )
    cli.main()

    merged = json.loads(out_path.read_text())
    assert merged["model"]["simBatches"] == 2
    assert merged["model"]["batchNames"] == ["a[0]", "a[2]"]


def test_batch_spec_is_passed_to_the_server(monkeypatch, tmp_path):
    scene_a = build_scene(batch_size=1)
    scene_b = build_scene(batch_size=2)
    path_a, path_b = tmp_path / "a.json", tmp_path / "b.json"
    scene_a.save(path_a)
    scene_b.save(path_b)

    calls = []
    monkeypatch.setattr(
        cli.SimViewServer, "start", staticmethod(lambda **kw: calls.append(kw))
    )
    monkeypatch.setattr(cli.sys, "argv", ["simview", str(path_a), f"{path_b}#1"])
    cli.main()

    assert calls[0]["sim_path"] == [path_a, path_b]
    assert calls[0]["batch_selections"] == [None, "1"]


def test_batch_spec_out_of_range_exits_with_an_error(capsys, monkeypatch, tmp_path):
    scene_a = build_scene(batch_size=1)
    scene_b = build_scene(batch_size=2)
    path_a, path_b = tmp_path / "a.json", tmp_path / "b.json"
    scene_a.save(path_a)
    scene_b.save(path_b)
    out_path = tmp_path / "merged.json"

    monkeypatch.setattr(
        cli.sys,
        "argv",
        ["simview", str(path_a), f"{path_b}#7", "--save-merged", str(out_path)],
    )
    with pytest.raises(SystemExit) as exc_info:
        cli.main()
    assert exc_info.value.code == 1
    assert "out of range" in capsys.readouterr().err
    assert not out_path.exists()


def test_batch_spec_loses_to_an_existing_file_with_a_hash_in_its_name(
    monkeypatch, tmp_path
):
    """A file literally named 'a#1.json' still opens as itself, mirroring how a
    local file beats the remote 'host:path' reading."""
    scene_a = build_scene(batch_size=1)
    scene_b = build_scene(batch_size=2)
    path_a, path_b = tmp_path / "a#1.json", tmp_path / "b.json"
    scene_a.save(path_a)
    scene_b.save(path_b)

    calls = []
    monkeypatch.setattr(
        cli.SimViewServer, "start", staticmethod(lambda **kw: calls.append(kw))
    )
    monkeypatch.setattr(cli.sys, "argv", ["simview", str(path_a), str(path_b)])
    cli.main()

    assert calls[0]["sim_path"] == [path_a, path_b]
    assert calls[0]["batch_selections"] == [None, None]
