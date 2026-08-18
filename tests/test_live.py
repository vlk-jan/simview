"""Tests for live streaming mode (simview.live.LiveViewer, and the live-mode
additions to SimViewServer: /states reporting {"live": true} and the
/ws/states broadcast endpoint).

Protocol-level tests drive a live-mode SimViewServer directly via
fastapi.testclient.TestClient (an in-process ASGI transport -- no real socket
needed, so no dependency on a running server thread). The integration test
exercises the real thing: a background-thread LiveViewer, a real bound TCP
port, and a real `websockets` client -- verifying the caller -> sender thread
-> server-loop bridge that push_state and _sender_loop implement between them.
The backpressure tests at the end cover the guarantee that matters most for
long runs: push_state never waits on the browser.
"""

import asyncio
import json
import threading
import time

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


# --- Backpressure: the caller's loop must never wait on the browser ---------


def test_push_state_does_not_block_on_a_stalled_broadcast():
    """A wedged broadcast must cost the caller nothing.

    The old implementation waited on the broadcast future for every frame, so
    a hung client stalled the simulation loop by up to 5s *per frame*.
    """
    scene = build_minimal_scene()
    pos = torch.tensor([[0.0, 0.0, 1.0]])
    quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]])

    with LiveViewer(scene, preferred_port=5996, open_browser=False) as live:
        release = threading.Event()
        first_broadcast = threading.Event()

        # Wedge the sender thread inside its very first broadcast.
        def _stalled_broadcast(frame: dict) -> None:
            first_broadcast.set()
            release.wait(timeout=10.0)

        live._broadcast = _stalled_broadcast

        live.push_state(0.0, [SimViewBodyState("Box", pos, quat)])
        assert first_broadcast.wait(timeout=5.0), "sender never started"

        started = time.monotonic()
        for i in range(1, 20):
            live.push_state(i * 0.1, [SimViewBodyState("Box", pos, quat)])
        elapsed = time.monotonic() - started

        # Generously above any plausible add_state cost, far below the 5s per
        # frame the blocking implementation would have charged.
        assert elapsed < 2.0, f"push_state blocked on the stalled sender ({elapsed}s)"
        # Every frame is still recorded regardless of the wedged stream.
        assert len(scene.states) == 20

        release.set()


def test_full_queue_drops_oldest_frames_but_keeps_recording():
    scene = build_minimal_scene()
    pos = torch.tensor([[0.0, 0.0, 1.0]])
    quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]])

    with LiveViewer(
        scene, preferred_port=5995, open_browser=False, queue_size=4
    ) as live:
        release = threading.Event()
        first_broadcast = threading.Event()

        def _stalled_broadcast(frame: dict) -> None:
            first_broadcast.set()
            release.wait(timeout=10.0)

        live._broadcast = _stalled_broadcast

        live.push_state(0.0, [SimViewBodyState("Box", pos, quat)])
        assert first_broadcast.wait(timeout=5.0), "sender never started"

        for i in range(1, 16):
            live.push_state(i * 0.1, [SimViewBodyState("Box", pos, quat)])

        # The queue is capped at 4, so the surplus was decimated off the wire.
        assert live.dropped_frames > 0
        # ...but neither the scene nor the catch-up buffer lost anything.
        assert len(scene.states) == 16
        assert len(live.server.frame_buffer) == 16

        release.set()


def test_stop_flushes_queued_frames_before_shutting_down():
    scene = build_minimal_scene()
    pos = torch.tensor([[0.0, 0.0, 1.0]])
    quat = torch.tensor([[1.0, 0.0, 0.0, 0.0]])

    live = LiveViewer(scene, preferred_port=5994, open_browser=False)
    sent: list[dict] = []

    def _record(frame: dict) -> None:
        sent.append(frame)

    live._broadcast = _record

    for i in range(5):
        live.push_state(i * 0.1, [SimViewBodyState("Box", pos, quat)])
    live.stop()

    assert len(sent) == 5
