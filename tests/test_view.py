import json
import re
from pathlib import Path

import pytest

from simview.columnar import expand_columnar_states, inline_blob
from simview.view import BOOLEAN_FLAG_KEYS, view_hash

JS = Path(__file__).parent.parent / "simview/static/js/utils/viewState.js"


def test_flag_keys_match_js():
    body = re.search(r"BOOLEAN_FLAG_KEYS = \[(.*?)\];", JS.read_text(), re.S)
    assert body
    assert tuple(re.findall(r'"([^"]+)"', body.group(1))) == BOOLEAN_FLAG_KEYS


def test_view_hash():
    assert view_hash() == "#"
    h = view_hash(
        t=1.25,
        cam=(1.5, 2, -0.0),
        tgt=(0, 0, 0.1234567),
        fov=50,
        batch=1,
        body_mode="mesh",
        terrain_color_mode="a b",
        flags={"axesVisible": True, "terrainProbe": True},
    )
    assert (
        h
        == "#v=1&t=1.25&cam=1.5,2,0&tgt=0,0,0.123457&fov=50&b=1&bvm=mesh&tcm=a%20b&flags=9"
    )
    assert view_hash(ui=False, data="http://h/x") == "#data=http%3A%2F%2Fh%2Fx&ui=0"
    assert view_hash(t=1, play=True) == "#v=1&t=1&play=1"
    assert view_hash(hide=["recording", "legend"]) == "#hide=recording,legend"
    assert view_hash(play=False) == "#"
    with pytest.raises(ValueError):
        view_hash(flags={"nope": True})
    # Named carry-over keys, in the JS serializer's order; absent means "leave alone".
    assert (
        view_hash(point_clouds=False, track="robot 1", color_map="viridis", speed=0.25)
        == "#v=1&pc=0&track=robot%201&cmap=viridis&speed=0.25"
    )
    with pytest.raises(ValueError):
        view_hash(speed=0)


def _urls(o):
    for v in o.values() if isinstance(o, dict) else o if isinstance(o, list) else []:
        if isinstance(v, str) and v.startswith("/blob/"):
            yield v
        else:
            yield from _urls(v)


def test_save_static(tmp_path):
    pytest.importorskip("torch")
    from conftest import build_scene

    scene = build_scene()
    scene.save_static(tmp_path)
    texts = [(tmp_path / f"{n}.json").read_text() for n in ("model", "states")]
    assert all("__b64__" not in t for t in texts)
    model, states = map(json.loads, texts)

    urls = list(_urls(model)) + list(_urls(states))
    assert urls
    assert all((tmp_path / u.lstrip("/")).stat().st_size % 4 == 0 for u in urls)

    def inline(o):
        for k, v in o.items() if isinstance(o, dict) else enumerate(o):
            if isinstance(v, str) and v.startswith("/blob/"):
                o[k] = inline_blob((tmp_path / v.lstrip("/")).read_bytes())
            elif isinstance(v, (dict, list)):
                inline(v)

    inline(states)
    expanded = expand_columnar_states(states, scene.model.batch_size)
    assert [f["time"] for f in expanded] == pytest.approx(
        [s["time"] for s in scene.states]
    )
    assert expanded[0]["bodies"][0]["name"] == scene.states[0]["bodies"][0]["name"]


def test_key_order_matches_js():
    full = view_hash(
        t=1,
        cam=(1, 2, 3),
        tgt=(0, 0, 0),
        fov=50,
        batch=0,
        body_mode="mesh",
        terrain_color_mode="height",
        flags={},
        point_clouds=True,
        track="b",
        color_map="viridis",
        speed=1,
    )
    py_order = tuple(kv.split("=")[0] for kv in full[1:].split("&")[1:])
    serializer = JS.read_text().split("export function serializeViewState")[1]
    serializer = serializer.split("export function parseViewState")[0]
    assert tuple(re.findall(r"params\.push\(`(\w+)=", serializer)) == py_order


def test_number_and_uri_formatting_match_js():
    """fmtNum: non-finite -> "0", >= 1e21 -> exponent form; encodeURIComponent
    leaves !'()* alone."""
    assert view_hash(t=float("nan"), fov=float("inf")) == "#v=1&t=0&fov=0"
    assert view_hash(t=1e21, fov=1.5e22) == "#v=1&t=1e+21&fov=1.5e+22"
    assert view_hash(t=1e20) == "#v=1&t=100000000000000000000"
    assert view_hash(body_mode="a!b'(c)*", track="x y") == (
        "#v=1&bvm=a!b'(c)*&track=x%20y"
    )
