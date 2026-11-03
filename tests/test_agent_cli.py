"""Agent-facing CLI additions: terrain area statistics/masks, `simview
sample`, batch names, diff time windows / alignment / cross-file inputs,
`info` value stats and `--full`, render shortcut flags, broken pipes."""

import csv
import io
import json
import math
import subprocess
import sys

import pytest

pytest.importorskip("torch")

from conftest import build_scene  # noqa: E402

import simview.__main__ as cli  # noqa: E402
from simview.diff import _align_to_first  # noqa: E402
from simview.sample import select_frames  # noqa: E402
from simview.terrain import parse_mask  # noqa: E402
from simview.utils import value_stats  # noqa: E402


def _run(monkeypatch, capsys, *argv):
    monkeypatch.setattr(cli.sys, "argv", ["simview", *argv])
    cli.main()
    return capsys.readouterr().out


@pytest.fixture
def two_batch(tmp_path):
    scene = build_scene(batch_size=2)
    scene.model.batch_names = ["GT", "pred"]
    path = tmp_path / "sim.json"
    scene.save(path)
    return path


def test_value_stats_skips_non_finite_and_uses_nearest_rank():
    st = value_stats([3.0, 1.0, math.nan, None, 2.0, math.inf])
    assert st["count"] == 3 and st["nan_count"] == 3
    assert (st["min"], st["p50"], st["max"]) == (1.0, 2.0, 3.0)
    assert st["mean"] == pytest.approx(2.0)
    assert value_stats([])["mean"] is None


def test_parse_mask():
    assert parse_mask("known>0.5") == ("known", ">", 0.5)
    assert parse_mask(" friction <= 1 ") == ("friction", "<=", 1.0)
    with pytest.raises(ValueError):
        parse_mask("known")
    with pytest.raises(ValueError):
        parse_mask("known>abc")


def test_terrain_area_defaults_to_stats_only(monkeypatch, capsys, two_batch):
    out = json.loads(
        _run(monkeypatch, capsys, "terrain", str(two_batch), "--area", "--json")
    )
    assert "layers" not in out and "x_coords" not in out
    assert out["area"]["nx"] == 4 and out["area"]["ny"] == 4
    assert out["stats"]["friction"]["mean"] == pytest.approx(0.5)
    assert out["stats"]["friction"]["count"] == 16


def test_terrain_area_mask_restricts_stats(monkeypatch, capsys, two_batch):
    out = json.loads(
        _run(
            monkeypatch,
            capsys,
            "terrain",
            str(two_batch),
            "--area",
            "--mask",
            "friction>0.9",
            "--json",
        )
    )
    assert out["mask"] == {"expr": "friction>0.9", "selected": 0, "total": 16}
    assert out["stats"]["height"]["count"] == 0


def test_terrain_area_diff_summary_and_csv(monkeypatch, capsys, two_batch):
    out = json.loads(
        _run(
            monkeypatch,
            capsys,
            "terrain",
            str(two_batch),
            "--area",
            "--batches",
            "GT",
            "pred",
            "--json",
        )
    )
    stats = out["layers"]["friction"]
    assert set(stats) == {"stats", "stats_a", "stats_b"}
    assert stats["stats"]["rmse"] == pytest.approx(0.0)

    rows = list(
        csv.reader(
            io.StringIO(
                _run(monkeypatch, capsys, "terrain", str(two_batch), "--area", "--csv")
            )
        )
    )
    assert rows[0][:3] == ["layer", "count", "nan_count"]
    assert {r[0] for r in rows[1:]} == {"height", "friction", "stiffness"}


def test_terrain_batch_by_name(monkeypatch, capsys, two_batch):
    out = json.loads(
        _run(
            monkeypatch,
            capsys,
            "terrain",
            str(two_batch),
            "--point",
            "0",
            "0",
            "--batch",
            "pred",
            "--json",
        )
    )
    assert out["batch"] == 1


def test_terrain_unknown_batch_name_errors(monkeypatch, capsys, two_batch):
    with pytest.raises(SystemExit) as e:
        _run(
            monkeypatch, capsys, "terrain", str(two_batch), "--area", "--batch", "nope"
        )
    assert e.value.code == 1
    assert "GT, pred" in capsys.readouterr().err


def test_select_frames():
    states = [{"time": t * 0.5} for t in range(10)]
    assert select_frames(states, count=3) == [0, 4, 9]
    assert select_frames(states, frames="::4") == [0, 4, 8]
    assert select_frames(states, frames="-1") == [9]
    assert select_frames(states, times=[1.1, 0.0, 99]) == [2, 0, 9]
    with pytest.raises(ValueError):
        select_frames(states, frames="20")
    with pytest.raises(ValueError):
        select_frames(states, frames="a:b")


def test_sample_reports_world_pose_fields_and_scalars(monkeypatch, capsys, two_batch):
    out = json.loads(
        _run(
            monkeypatch,
            capsys,
            "sample",
            str(two_batch),
            "--t",
            "0.2",
            "--batch",
            "pred",
            "--json",
        )
    )
    assert out["batches"] == {"pred": 1}
    (frame,) = out["frames"]
    assert frame["frame"] == 2
    box = frame["bodies"]["Box"]["pred"]
    assert box["position"] == pytest.approx([0.0, 0.0, 2.0])
    assert box["orientation_wxyz"] == pytest.approx([1.0, 0.0, 0.0, 0.0])
    assert box["velocity"] == pytest.approx([0.0, 0.0, 0.0])
    assert frame["scalars"]["energy"] == {"pred": 1.0}


def test_sample_text_and_csv(monkeypatch, capsys, two_batch):
    text = _run(monkeypatch, capsys, "sample", str(two_batch))
    assert "frame 0" in text and "frame 2" in text and "GT: pos=" in text
    rows = list(
        csv.reader(
            io.StringIO(_run(monkeypatch, capsys, "sample", str(two_batch), "--csv"))
        )
    )
    assert rows[0][:4] == ["frame", "time", "body", "batch"]
    assert len(rows) == 1 + 3 * 2  # 3 frames x 2 batches, one body


def test_diff_defaults_batches_and_accepts_names(monkeypatch, capsys, two_batch):
    default = json.loads(_run(monkeypatch, capsys, "diff", str(two_batch), "--json"))
    named = json.loads(
        _run(
            monkeypatch,
            capsys,
            "diff",
            str(two_batch),
            "--batches",
            "pred",
            "GT",
            "--json",
        )
    )
    assert (default["batch_a"], default["batch_b"]) == (0, 1)
    assert (named["batch_a"], named["batch_b"]) == (1, 0)


def test_diff_time_window(monkeypatch, capsys, two_batch):
    out = json.loads(
        _run(monkeypatch, capsys, "diff", str(two_batch), "--t0", "0.05", "--json")
    )
    assert out["bodies"]["Box"]["frame_indices"] == [1, 2]
    assert out["t0"] == 0.05


def test_diff_across_files(monkeypatch, capsys, tmp_path):
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    build_scene(batch_size=1).save(a)
    build_scene(batch_size=1).save(b)
    out = json.loads(_run(monkeypatch, capsys, "diff", str(a), str(b), "--json"))
    assert out["bodies"]["Box"]["summary"]["position_error"]["max"] == 0.0


def test_align_to_first_removes_start_offset():
    yaw90 = [math.sqrt(0.5), 0.0, 0.0, math.sqrt(0.5)]
    first = [1.0, 2.0, 0.0, *yaw90]
    # One metre "forward" (+x in the body frame = +y in the world after yaw 90).
    later = [1.0, 3.0, 0.0, *yaw90]
    aligned = _align_to_first(later, first)
    assert aligned[:3] == pytest.approx([1.0, 0.0, 0.0])
    assert aligned[3:] == pytest.approx([1.0, 0.0, 0.0, 0.0])


def test_info_value_stats_and_full(monkeypatch, capsys, two_batch):
    out = json.loads(
        _run(monkeypatch, capsys, "info", str(two_batch), "--json", "--full")
    )
    states = out["states"]
    assert states["scalars"]["energy"]["stats"]["GT"]["mean"] == pytest.approx(1.0)
    bounds = states["bodies"]["entries"]["Box"]["position_bounds"]["pred"]
    assert bounds["min"][2] == pytest.approx(0.0)
    assert bounds["max"][2] == pytest.approx(2.0)
    assert out["model"]["episodes"] == []


def test_render_shortcut_flags_build_hash(monkeypatch, tmp_path, two_batch):
    import simview.render as render_mod

    calls = []
    monkeypatch.setattr(
        render_mod, "render_screenshots", lambda path, shots, **kw: calls.append(shots)
    )
    monkeypatch.setattr(
        cli.sys,
        "argv",
        [
            "simview",
            "render",
            str(two_batch),
            "--output",
            str(tmp_path / "f.png"),
            "--t",
            "0.1",
            "--t",
            "0.2",
            "--camera",
            "top",
            "--batch",
            "pred",
            "--terrain-color",
            "friction",
        ],
    )
    cli.main()
    (shots,) = calls
    assert [p.name for _, p in shots] == ["f_t0.1.png", "f_t0.2.png"]
    view = shots[0][0]
    assert "t=0.1" in view and "b=1" in view and "tcm=friction" in view
    # Batch 1 is the second cell of the batch grid: one 10 m terrain + 0.5 m over.
    assert "cam=10.5,-0.01,15" in view and "tgt=10.5,0,0" in view


def test_render_view_conflicts_with_shortcuts(monkeypatch, capsys, tmp_path, two_batch):
    with pytest.raises(SystemExit):
        _run(
            monkeypatch,
            capsys,
            "render",
            str(two_batch),
            "--output",
            str(tmp_path / "f.png"),
            "--view",
            "#v=1",
            "--t",
            "1",
        )
    assert "can't be combined" in capsys.readouterr().err


def test_broken_pipe_is_quiet(two_batch):
    proc = subprocess.run(
        f"{sys.executable} -m simview terrain {two_batch} --area --full | head -c 1",
        shell=True,
        capture_output=True,
        text=True,
    )
    assert "Traceback" not in proc.stderr


def _write_doc(path, bodies_per_frame, batch_size=1):
    doc = {
        "model": {"simBatches": batch_size, "scalarNames": [], "dt": 1.0, "bodies": []},
        "states": [
            {"time": float(i), "bodies": bodies}
            for i, bodies in enumerate(bodies_per_frame)
        ],
    }
    path.write_text(json.dumps(doc))
    return path


def test_info_bounds_use_grouped_body_pose_and_skip_nan(tmp_path):
    from simview.info import summarize_scene

    ident = [1.0, 0.0, 0.0, 0.0]
    path = _write_doc(
        tmp_path / "s.json",
        [
            [
                {"name": "a", "bodyTransform": [0.0, 0.0, 0.0, *ident]},
                {"name": ["a+b", "c"], "bodyTransform": [math.nan, 5.0, 5.0, *ident]},
            ],
            [
                {"name": "a", "bodyTransform": [0.0, 0.0, 0.0, *ident]},
                {"name": ["a+b", "c"], "bodyTransform": [5.0, 5.0, 5.0, *ident]},
            ],
        ],
    )
    entries = summarize_scene(path)["states"]["bodies"]["entries"]
    assert entries["a+b+c"]["position_bounds"]["0"] == {
        "min": [5.0, 5.0, 5.0],
        "max": [5.0, 5.0, 5.0],
    }


def test_info_warns_instead_of_crashing_on_null_transform(tmp_path):
    from simview.info import summarize_scene

    path = _write_doc(
        tmp_path / "s.json",
        [[{"name": "a", "bodyTransform": None, "contacts": [7]}]],
    )
    summary = summarize_scene(path)
    assert any("could not be decoded" in w for w in summary["warnings"])


def test_mask_never_selects_nan_cells():
    from simview import terrain

    nan_grid = [[math.nan, 1.0]]
    model = {
        "simBatches": 1,
        "terrain": {
            "dimensions": {"resolutionX": 2, "resolutionY": 1},
            "bounds": {"minX": 0, "maxX": 1, "minY": 0, "maxY": 0},
            "heightData": nan_grid,
            "properties": {"known": {"data": nan_grid}},
        },
    }
    keep = terrain._mask_cells(model, ("known", "!=", 0.0), 0, [0], [0, 1])
    assert keep == [[False, True]]


def test_select_frames_empty_selection_errors():
    with pytest.raises(ValueError, match="selects none"):
        select_frames([{"time": 0.0}] * 3, frames="3:3")
