"""Non-finite floats must be written as `null`: stdlib json's bare NaN/Infinity
tokens are invalid JSON that JSON.parse, orjson and jq reject."""

import asyncio
import json
import math

import pytest

torch = pytest.importorskip("torch")

from conftest import build_scene
from fastapi.testclient import TestClient

import simview.__main__ as cli
from simview.merge import _load_json
from simview.scene import SimulationScene
from simview.server import SimViewServer
from simview.state import SimViewBodyState

NAN = float("nan")


def _strict_loads(text: str):
    def reject(token):
        raise ValueError(f"non-standard JSON token {token}")

    return json.loads(text, parse_constant=reject)


def _nan_scene() -> SimulationScene:
    scene = build_scene(batch_size=2)
    pos = torch.tensor([[0.0, 0.0, 3.0], [NAN, 0.0, 3.0]])
    quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]] * 2)
    state = SimViewBodyState("Box", pos, quat, {"velocity": torch.zeros(2, 3)})
    scene.add_state(time=NAN, body_states=[state], scalar_values={"energy": [NAN, 1.0]})
    return scene


@pytest.mark.parametrize("columnar", [None, False])
def test_save_writes_nan_as_null(tmp_path, columnar):
    path = tmp_path / "sim.json"
    _nan_scene().save(path, columnar=columnar)

    text = path.read_text()
    _strict_loads(text)
    assert "null" in text

    loaded = SimulationScene.load(path)
    assert loaded.states[-1]["time"] is None
    with TestClient(SimViewServer(sim_path=path).app) as client:
        assert client.get("/states").status_code == 200


def test_legacy_nan_files_still_load(tmp_path):
    """Files written before the fix contain bare NaN; orjson alone rejects them."""
    path = tmp_path / "old.json"
    scene = build_scene(batch_size=2)
    scene.save(path, columnar=False)
    data = json.loads(path.read_text())
    data["states"][0]["time"] = NAN
    path.write_text(json.dumps(data))

    assert "NaN" in path.read_text()
    assert math.isnan(_load_json(path)["states"][0]["time"])
    with TestClient(SimViewServer(sim_path=path).app) as client:
        assert client.get("/states").status_code == 200


def test_live_messages_are_strict_json():
    server = SimViewServer(
        data={"model": {"simBatches": 1, "bodies": {}}, "states": []}, live=True
    )
    frame = {"time": 0.0, "bodies": [], "r": [NAN]}
    server.push_frame(frame)
    with TestClient(server.app) as client:
        with client.websocket_connect("/ws/states") as ws:
            catchup = _strict_loads(ws.receive_text())
            asyncio.run_coroutine_threadsafe(
                server.broadcast_frame(frame, 1), server.loop
            ).result(timeout=5.0)
            live = _strict_loads(ws.receive_text())
    assert catchup["states"][0]["r"] == [None]
    assert live["states"][0]["r"] == [None]


@pytest.mark.parametrize(
    "args", [["info"], ["diff", "--batches", "0", "1"]], ids=["info", "diff"]
)
def test_cli_json_output_is_strict(capsys, monkeypatch, tmp_path, args):
    path = tmp_path / "sim.json"
    _nan_scene().save(path)

    monkeypatch.setattr(
        cli.sys, "argv", ["simview", args[0], str(path), *args[1:], "--json"]
    )
    cli.main()

    _strict_loads(capsys.readouterr().out)
