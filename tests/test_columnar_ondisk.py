"""Tests for the columnar states layout as an *on-disk* format:
`SimulationScene.save(columnar=...)`, `load`'s expansion of it, and every
other reader (merge, the stdlib CLI tools, the server) accepting it.

`simview/columnar.py`'s expansion side is stdlib-only on purpose, so the
expander tests at the bottom deliberately avoid torch.
"""

import json

import pytest

from simview.columnar import (
    COLUMNAR_VERSION,
    expand_columnar_states,
    inline_blob,
    is_columnar,
)

pytest.importorskip("torch")

import struct

import torch
from conftest import build_scene
from fastapi.testclient import TestClient

from simview.diff import load_scene as diff_load_scene
from simview.info import summarize_scene
from simview.merge import merge_simulation_files
from simview.scene import BodyShapeType, SimulationScene
from simview.server import SimViewServer
from simview.state import BodyTrajectory, SimViewBodyState


def _read(path):
    return json.loads(path.read_text())


# --- save() ----------------------------------------------------------------


def test_save_writes_columnar_by_default(tmp_path):
    scene = build_scene(batch_size=2)
    out = tmp_path / "sim.json"
    scene.save(out)

    states = _read(out)["states"]
    assert is_columnar(states)
    assert states["version"] == COLUMNAR_VERSION
    assert states["times"] == [0.0, 0.1, 0.2]
    # One whole-trajectory blob per body per field, not one per frame.
    body = states["bodies"][0]
    assert body["name"] == "Box"
    assert set(body["fields"]) == {"bodyTransform", "velocity"}
    assert body["fields"]["bodyTransform"].startswith("__b64__")
    assert states["scalars"]["energy"].startswith("__b64__")


def test_columnar_false_writes_the_legacy_array(tmp_path):
    scene = build_scene(batch_size=2)
    out = tmp_path / "sim.json"
    scene.save(out, columnar=False)

    states = _read(out)["states"]
    assert isinstance(states, list)
    assert len(states) == 3


def test_columnar_file_is_smaller_than_the_legacy_one(tmp_path):
    """The point of the format: far fewer, far bigger JSON values."""
    T, B = 200, 2
    scene = SimulationScene(batch_size=B, scalar_names=[], dt=0.1)
    heights = torch.zeros(4, 4)
    normals = torch.zeros(3, 4, 4)
    normals[2] = 1.0
    scene.create_terrain(
        heightmap=heights, normals=normals, x_lim=(-5, 5), y_lim=(-5, 5)
    )
    scene.create_body(
        body_name="Box", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5
    )
    quat = torch.zeros(T, B, 4)
    quat[..., 0] = 1.0
    scene.add_trajectory(
        times=torch.arange(T) * 0.1,
        trajectories=[BodyTrajectory("Box", torch.randn(T, B, 3), quat)],
    )

    columnar_path = tmp_path / "columnar.json"
    legacy_path = tmp_path / "legacy.json"
    scene.save(columnar_path)
    scene.save(legacy_path, columnar=False)

    assert columnar_path.stat().st_size < legacy_path.stat().st_size


def test_columnar_true_raises_when_states_cannot_be_packed(tmp_path):
    """A body that only shows up mid-run can't be columnarized; columnar=True
    must say so rather than silently writing the legacy layout."""
    scene = SimulationScene(batch_size=1, scalar_names=[], dt=0.1)
    heights = torch.zeros(4, 4)
    normals = torch.zeros(3, 4, 4)
    normals[2] = 1.0
    scene.create_terrain(
        heightmap=heights, normals=normals, x_lim=(-5, 5), y_lim=(-5, 5)
    )
    scene.create_body(
        body_name="Box", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5
    )
    scene.create_body(
        body_name="Late", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5
    )
    pos = torch.tensor([[0.0, 0.0, 0.0]])
    quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]])
    scene.add_state(0.0, [SimViewBodyState("Box", pos, quat)])
    scene.add_state(
        0.1,
        [SimViewBodyState("Box", pos, quat), SimViewBodyState("Late", pos, quat)],
    )

    with pytest.raises(ValueError, match="columnar=True"):
        scene.save(tmp_path / "sim.json", columnar=True)

    # The default silently falls back instead.
    out = tmp_path / "fallback.json"
    scene.save(out)
    assert isinstance(_read(out)["states"], list)


def test_columnar_survives_gzip(tmp_path):
    scene = build_scene(batch_size=2)
    out = tmp_path / "sim.json.gz"
    scene.save(out, compress=True)

    loaded = SimulationScene.load(out)
    assert len(loaded.states) == 3


# --- readers ---------------------------------------------------------------


def test_load_expands_columnar_into_per_frame_states(tmp_path):
    scene = build_scene(batch_size=2)
    columnar_path = tmp_path / "columnar.json"
    legacy_path = tmp_path / "legacy.json"
    scene.save(columnar_path)
    scene.save(legacy_path, columnar=False)

    from_columnar = SimulationScene.load(columnar_path)
    from_legacy = SimulationScene.load(legacy_path)

    # Expansion is exact: loading either file gives the same in-memory states.
    assert from_columnar.states == from_legacy.states


def test_merge_accepts_columnar_files(tmp_path):
    path_a = tmp_path / "a.json"
    path_b = tmp_path / "b.json"
    build_scene(batch_size=1).save(path_a)
    build_scene(batch_size=1).save(path_b)

    merged = merge_simulation_files([path_a, path_b])

    assert merged["model"]["simBatches"] == 2
    assert len(merged["states"]) == 3


def test_merge_accepts_a_columnar_and_a_legacy_file(tmp_path):
    path_a = tmp_path / "a.json"
    path_b = tmp_path / "b.json"
    build_scene(batch_size=1).save(path_a)
    build_scene(batch_size=1).save(path_b, columnar=False)

    merged = merge_simulation_files([path_a, path_b])

    assert merged["model"]["simBatches"] == 2
    assert len(merged["states"]) == 3


def test_diff_accepts_columnar_files(tmp_path):
    from simview.diff import compute_trajectory_diff

    path = tmp_path / "sim.json"
    build_scene(batch_size=2).save(path)

    model, states = diff_load_scene(path)
    result = compute_trajectory_diff(model, states, batch_a=0, batch_b=1)

    assert result["bodies"]["Box"]["summary"]["frame_count"] == 3


def test_info_reports_the_layout(tmp_path):
    columnar_path = tmp_path / "columnar.json"
    legacy_path = tmp_path / "legacy.json"
    build_scene(batch_size=2).save(columnar_path)
    build_scene(batch_size=2).save(legacy_path, columnar=False)

    assert summarize_scene(columnar_path)["states"]["layout"] == "columnar"
    assert summarize_scene(legacy_path)["states"]["layout"] == "legacy"
    # ...and the frame-level summary is identical either way.
    columnar_states = summarize_scene(columnar_path)["states"]
    legacy_states = summarize_scene(legacy_path)["states"]
    assert columnar_states["frame_count"] == legacy_states["frame_count"]
    assert columnar_states["bodies"] == legacy_states["bodies"]


def test_server_serves_a_columnar_file_without_repacking(tmp_path):
    path = tmp_path / "sim.json"
    build_scene(batch_size=2).save(path)

    server = SimViewServer(sim_path=path)
    with TestClient(server.app) as client:
        states = client.get("/states").json()
        assert states["version"] == COLUMNAR_VERSION
        # Inline __b64__ blobs became /blob/ URLs the browser fetches.
        blob_url = states["bodies"][0]["fields"]["bodyTransform"]
        assert blob_url.startswith("/blob/")
        blob = client.get(blob_url)
        assert blob.status_code == 200
        # (T=3, B=2, 7) float32
        assert len(blob.content) == 3 * 2 * 7 * 4


# --- expand_columnar_states (stdlib only) ----------------------------------


def test_expand_rejects_a_non_columnar_document():
    with pytest.raises(ValueError, match="not a columnar"):
        expand_columnar_states([{"time": 0.0}], 1)


def test_expand_rejects_a_truncated_blob():
    doc = {
        "version": COLUMNAR_VERSION,
        "times": [0.0, 0.1],
        # Only one frame's worth of floats for a two-frame document.
        "bodies": [
            {
                "name": "Box",
                "fields": {"bodyTransform": inline_blob(struct.pack("<7f", *range(7)))},
            }
        ],
        "scalars": {},
    }
    with pytest.raises(ValueError, match="expected 14"):
        expand_columnar_states(doc, 1)


def test_expand_rejects_an_unknown_field():
    doc = {
        "version": COLUMNAR_VERSION,
        "times": [0.0],
        "bodies": [
            {"name": "Box", "fields": {"bogus": inline_blob(b"\x00\x00\x00\x00")}}
        ],
        "scalars": {},
    }
    with pytest.raises(ValueError, match="unknown columnar field"):
        expand_columnar_states(doc, 1)


def test_expand_carries_contacts_and_scalars():
    doc = {
        "version": COLUMNAR_VERSION,
        "times": [0.0, 0.1],
        "bodies": [
            {
                "name": "Box",
                "fields": {
                    "bodyTransform": inline_blob(struct.pack("<14f", *range(14)))
                },
                "contacts": [[1, 2], None],
            }
        ],
        "scalars": {"energy": inline_blob(struct.pack("<2f", 5.0, 6.0))},
    }

    states = expand_columnar_states(doc, 1)

    assert [s["time"] for s in states] == [0.0, 0.1]
    assert states[0]["bodies"][0]["contacts"] == [1, 2]
    # A None contacts entry means "no contacts this frame", not an empty list.
    assert "contacts" not in states[1]["bodies"][0]
    assert states[0]["energy"] == [5.0]
    assert states[1]["energy"] == [6.0]


# --- Ranged blob fetches (windowed state loading) --------------------------
#
# The viewer windows a long trajectory's blobs instead of pulling whole
# (T, B, k) runs into memory; that needs the blob endpoint to honor Range.
# See simview/server.py::_parse_byte_range and static/js/utils/blobWindow.js.


def _blob_url(client) -> str:
    states = client.get("/states").json()
    return states["bodies"][0]["fields"]["bodyTransform"]


def _columnar_client(tmp_path):
    path = tmp_path / "sim.json"
    build_scene(batch_size=2).save(path)
    return TestClient(SimViewServer(sim_path=path).app)


def test_blob_endpoint_advertises_range_support(tmp_path):
    with _columnar_client(tmp_path) as client:
        response = client.get(_blob_url(client))
        assert response.status_code == 200
        assert response.headers["accept-ranges"] == "bytes"


def test_blob_endpoint_serves_a_byte_range(tmp_path):
    with _columnar_client(tmp_path) as client:
        url = _blob_url(client)
        whole = client.get(url).content
        # One frame of (B=2, 7) float32 = 56 bytes; take the second frame.
        response = client.get(url, headers={"Range": "bytes=56-111"})

        assert response.status_code == 206
        assert response.content == whole[56:112]
        assert response.headers["content-range"] == f"bytes 56-111/{len(whole)}"


def test_open_ended_and_suffix_ranges(tmp_path):
    with _columnar_client(tmp_path) as client:
        url = _blob_url(client)
        whole = client.get(url).content

        open_ended = client.get(url, headers={"Range": "bytes=56-"})
        assert open_ended.status_code == 206
        assert open_ended.content == whole[56:]

        suffix = client.get(url, headers={"Range": "bytes=-56"})
        assert suffix.status_code == 206
        assert suffix.content == whole[-56:]


def test_range_past_the_end_is_unsatisfiable(tmp_path):
    with _columnar_client(tmp_path) as client:
        url = _blob_url(client)
        size = len(client.get(url).content)

        response = client.get(url, headers={"Range": f"bytes={size}-{size + 10}"})

        assert response.status_code == 416
        assert response.headers["content-range"] == f"bytes */{size}"


def test_a_range_that_overruns_the_end_is_clamped(tmp_path):
    with _columnar_client(tmp_path) as client:
        url = _blob_url(client)
        whole = client.get(url).content

        response = client.get(url, headers={"Range": f"bytes=56-{len(whole) + 999}"})

        assert response.status_code == 206
        assert response.content == whole[56:]


@pytest.mark.parametrize(
    "header",
    [
        "",
        "bytes=",
        "bytes=abc-def",
        "items=0-10",  # a unit we don't serve
        "bytes=0-10, 20-30",  # multi-range
    ],
)
def test_unusable_range_headers_fall_back_to_the_whole_blob(tmp_path, header):
    with _columnar_client(tmp_path) as client:
        url = _blob_url(client)
        whole = client.get(url).content

        response = client.get(url, headers={"Range": header})

        assert response.status_code == 200
        assert response.content == whole
