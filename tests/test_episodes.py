"""Tests for episode boundaries (SimViewEpisode, SimulationScene.mark_episode,
LiveViewer.mark_episode and the model wire format).

The browser half lives in tests/js/episodes.test.js.
"""

import json

import pytest

pytest.importorskip("torch")

import torch
from conftest import build_scene
from fastapi.testclient import TestClient

from simview.merge import merge_simulation_files
from simview.model import SimViewEpisode
from simview.scene import SimulationScene
from simview.server import SimViewServer
from simview.state import SimViewBodyState


def test_episode_to_json_omits_an_absent_label():
    assert SimViewEpisode(0).to_json() == {"startIndex": 0}
    assert SimViewEpisode(2, "reset").to_json() == {"startIndex": 2, "label": "reset"}


def test_episode_rejects_a_negative_or_non_integer_start():
    with pytest.raises(ValueError, match=">= 0"):
        SimViewEpisode(-1)
    with pytest.raises(ValueError, match="must be an int"):
        SimViewEpisode(1.5)  # pyright: ignore[reportArgumentType]
    # bool is an int subclass, but a boolean frame index is always a mistake.
    with pytest.raises(ValueError, match="must be an int"):
        SimViewEpisode(True)  # pyright: ignore[reportArgumentType]


def test_mark_episode_defaults_to_the_next_frame_index():
    scene = build_scene(batch_size=1)  # already has 3 states
    episode = scene.mark_episode(label="second")

    assert episode.start_index == 3
    assert [e.to_json() for e in scene.model.episodes or []] == [
        {"startIndex": 3, "label": "second"}
    ]


def test_mark_episode_accepts_an_explicit_index_for_an_existing_recording():
    scene = build_scene(batch_size=1)
    scene.mark_episode(label="a", start_index=0)
    scene.mark_episode(label="b", start_index=2)

    assert [e.start_index for e in scene.model.episodes or []] == [0, 2]


def test_episode_starts_must_strictly_increase():
    scene = build_scene(batch_size=1)
    scene.mark_episode(start_index=5)

    with pytest.raises(ValueError, match="strictly increasing"):
        scene.mark_episode(start_index=5)
    with pytest.raises(ValueError, match="strictly increasing"):
        scene.mark_episode(start_index=2)

    # The rejected marks left the scene untouched.
    assert [e.start_index for e in scene.model.episodes or []] == [5]


def test_episodes_round_trip_through_save_and_load(tmp_path):
    scene = build_scene(batch_size=2)
    scene.mark_episode(label="first", start_index=0)
    scene.mark_episode(label="second", start_index=2)

    out = tmp_path / "sim.json"
    scene.save(out)

    assert json.loads(out.read_text())["model"]["episodes"] == [
        {"startIndex": 0, "label": "first"},
        {"startIndex": 2, "label": "second"},
    ]

    loaded = SimulationScene.load(out)
    assert [(e.start_index, e.label) for e in loaded.model.episodes or []] == [
        (0, "first"),
        (2, "second"),
    ]


def test_a_scene_without_episodes_has_no_episodes_key(tmp_path):
    out = tmp_path / "sim.json"
    build_scene(batch_size=1).save(out)
    assert "episodes" not in json.loads(out.read_text())["model"]


def test_merge_keeps_the_first_files_episodes_and_drops_the_rest(tmp_path, caplog):
    scene_a = build_scene(batch_size=1)
    scene_a.mark_episode(label="a-ep", start_index=1)
    path_a = tmp_path / "a.json"
    scene_a.save(path_a)

    scene_b = build_scene(batch_size=1)
    scene_b.mark_episode(label="b-ep", start_index=2)
    path_b = tmp_path / "b.json"
    scene_b.save(path_b)

    merged = merge_simulation_files([path_a, path_b])

    # The merged timeline is the first file's, so only its episodes still index
    # the right frames.
    assert merged["model"]["episodes"] == [{"startIndex": 1, "label": "a-ep"}]
    assert "Dropping episode boundaries" in caplog.text


def test_server_serves_episodes_in_the_model(tmp_path):
    scene = build_scene(batch_size=1)
    scene.mark_episode(label="ep", start_index=1)
    path = tmp_path / "sim.json"
    scene.save(path)

    server = SimViewServer(sim_path=path)
    with TestClient(server.app) as client:
        model = client.get("/model").json()
        assert model["episodes"] == [{"startIndex": 1, "label": "ep"}]


# --- Live mode -------------------------------------------------------------


def _minimal_live_scene() -> SimulationScene:
    from simview.scene import BodyShapeType

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
    return scene


def test_live_mark_episode_updates_the_model_and_broadcasts():
    websockets_sync = pytest.importorskip("websockets.sync.client")
    from simview.live import LiveViewer

    scene = _minimal_live_scene()
    pos = torch.tensor([[0.0, 0.0, 1.0]])
    quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]])

    with LiveViewer(scene, preferred_port=5993, open_browser=False) as live:
        live.push_state(0.0, [SimViewBodyState("Box", pos, quat)])

        with websockets_sync.connect(f"ws://127.0.0.1:{live.port}/ws/states") as ws:
            json.loads(ws.recv(timeout=5.0))  # catch-up

            live.mark_episode(label="episode 2")

            message = json.loads(ws.recv(timeout=5.0))
            assert message == {"episodes": [{"startIndex": 1, "label": "episode 2"}]}

        # A viewer connecting later picks the same boundaries up from /model.
        assert live.server.model_data is not None
        assert live.server.model_data["episodes"] == [
            {"startIndex": 1, "label": "episode 2"}
        ]
        # ...and the scene itself records them, so save() keeps them.
        assert [e.start_index for e in scene.model.episodes or []] == [1]
