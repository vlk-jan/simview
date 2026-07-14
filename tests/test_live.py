"""Tests for live streaming mode (simview.live.LiveViewer, and the live-mode
additions to SimViewServer: /states reporting {"live": true} and the
/ws/states broadcast endpoint).

Protocol-level tests drive a live-mode SimViewServer directly via
fastapi.testclient.TestClient (an in-process ASGI transport -- no real socket
needed, so no dependency on a running server thread). The final test exercises
the real thing: a background-thread LiveViewer, a real bound TCP port, and a
real `websockets` client -- verifying the caller-thread -> server-loop bridge
that asyncio.run_coroutine_threadsafe implements in push_state.
"""

import asyncio
import json

import pytest

pytest.importorskip("torch")

import torch
from fastapi.testclient import TestClient

from simview.live import LiveViewer
from simview.scene import BodyShapeType, SimulationScene
from simview.server import SimViewServer
from simview.state import SimViewBodyState


def _minimal_model_data():
    """A bare-bones but complete model dict, enough for SimViewServer's
    live-mode routes (which don't need real terrain/body content)."""
    return {
        "simBatches": 1,
        "scalarNames": [],
        "dt": 0.1,
        "collapse": False,
        "bodies": {},
        "staticObjects": {},
        "terrain": None,
    }


@pytest.fixture
def live_client():
    server = SimViewServer(
        data={"model": _minimal_model_data(), "states": []}, live=True
    )
    with TestClient(server.app) as client:
        yield server, client


def test_states_endpoint_reports_live(live_client):
    _server, client = live_client
    resp = client.get("/states")
    assert resp.status_code == 200
    assert resp.json() == {"live": True}
    # Same gzip-Content-Encoding contract as the static /states payload.
    assert resp.headers["content-encoding"] == "gzip"


def test_websocket_catchup_replays_buffered_frames(live_client):
    server, client = live_client
    server.frame_buffer.append({"time": 0.0, "bodies": []})
    server.frame_buffer.append({"time": 0.1, "bodies": []})

    with client.websocket_connect("/ws/states") as ws:
        message = json.loads(ws.receive_text())
        assert message == {
            "states": [
                {"time": 0.0, "bodies": []},
                {"time": 0.1, "bodies": []},
            ]
        }


def test_websocket_receives_frame_pushed_after_connect(live_client):
    server, client = live_client

    with client.websocket_connect("/ws/states") as ws:
        frame = {"time": 0.2, "bodies": []}
        server.frame_buffer.append(frame)
        future = asyncio.run_coroutine_threadsafe(
            server.broadcast_frame(frame), server.loop
        )
        future.result(timeout=5.0)

        message = json.loads(ws.receive_text())
        assert message == {"states": [frame]}


def test_broadcast_drops_dead_connection_without_raising(live_client):
    server, _client = live_client

    class _DeadSocket:
        async def send_text(self, _msg):
            raise RuntimeError("connection is closed")

    dead = _DeadSocket()
    server.ws_clients.add(dead)

    async def _run():
        await server.broadcast_frame({"time": 0.0, "bodies": []})

    asyncio.run(_run())

    assert dead not in server.ws_clients


# --- Full integration: real background thread + real socket -----------------


def build_minimal_scene() -> SimulationScene:
    scene = SimulationScene(batch_size=1, scalar_names=[], dt=0.1)
    resolution = 4
    heights = torch.zeros(resolution, resolution)
    normals = torch.zeros(3, resolution, resolution)
    normals[2] = 1.0
    scene.create_terrain(
        heightmap=heights, normals=normals, x_lim=(-5, 5), y_lim=(-5, 5)
    )
    scene.create_body(
        body_name="Box", shape_type=BodyShapeType.BOX, hx=0.5, hy=0.5, hz=0.5
    )
    return scene


def test_live_viewer_end_to_end_with_real_websocket_client():
    websockets_sync = pytest.importorskip("websockets.sync.client")

    scene = build_minimal_scene()
    with LiveViewer(scene, preferred_port=5998, open_browser=False) as live:
        pos = torch.tensor([[0.0, 0.0, 1.0]])
        quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]])
        # Pushed before any client connects: only buffered, delivered as
        # catch-up once the socket below connects.
        live.push_state(0.0, [SimViewBodyState("Box", pos, quat)])

        with websockets_sync.connect(f"ws://127.0.0.1:{live.port}/ws/states") as ws:
            catchup = json.loads(ws.recv(timeout=5.0))
            assert len(catchup["states"]) == 1
            assert catchup["states"][0]["time"] == 0.0
            assert catchup["states"][0]["bodies"][0]["name"] == "Box"

            # Pushed after connect: delivered as its own live message.
            live.push_state(0.1, [SimViewBodyState("Box", pos, quat)])
            pushed = json.loads(ws.recv(timeout=5.0))
            assert pushed["states"][0]["time"] == 0.1
            assert pushed["states"][0]["bodies"][0]["name"] == "Box"

        # Both frames also landed in the scene itself, so save() still works.
        assert len(scene.states) == 2


def test_live_viewer_stop_is_idempotent():
    scene = build_minimal_scene()
    live = LiveViewer(scene, preferred_port=5997, open_browser=False)
    live.stop()
    live.stop()  # must not raise
