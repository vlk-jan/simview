"""Tests for SimulationScene.show / ViewerHandle -- the non-blocking viewer
entry point intended for Jupyter notebooks and scripts (as opposed to
SimViewLauncher/SimViewServer.run, which block, and LiveViewer, which is for
streaming states incrementally).

These drive a real background-thread server over a real bound TCP port (via
httpx), rather than FastAPI's in-process TestClient, since the whole point of
`show` is that it doesn't block the caller.
"""

import socket

import httpx
import pytest

pytest.importorskip("torch")

from conftest import build_scene

from simview.scene import SimulationScene, ViewerHandle


def _port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def test_show_serves_model_and_states_over_real_http():
    scene = build_scene(batch_size=1)
    handle = scene.show(preferred_port=6010)
    try:
        assert isinstance(handle, ViewerHandle)
        model_resp = httpx.get(f"{handle.url}/model", timeout=5.0)
        assert model_resp.status_code == 200
        states_resp = httpx.get(f"{handle.url}/states", timeout=5.0)
        assert states_resp.status_code == 200
        # states_resp is the columnar v4 payload (see SimViewServer /states);
        # just check the frame count round-trips, not the exact shape.
        assert len(states_resp.json()["times"]) == len(scene.states)
    finally:
        handle.stop()


def test_repr_html_contains_url():
    scene = build_scene(batch_size=1)
    with scene.show(preferred_port=6011) as handle:
        html = handle._repr_html_()
        assert handle.url in html
        assert "<iframe" in html
        assert 'width="100%"' in html
        assert 'height="600"' in html


def test_stop_is_idempotent_and_frees_thread():
    scene = build_scene(batch_size=1)
    handle = scene.show(preferred_port=6012)
    thread = handle._threaded._thread

    handle.stop()
    assert not thread.is_alive()

    handle.stop()  # must not raise
    assert not thread.is_alive()


def test_show_rejects_incomplete_scene():
    incomplete = SimulationScene(batch_size=1, scalar_names=[], dt=0.1)  # no terrain
    with pytest.raises(ValueError, match="not complete"):
        incomplete.show()


def test_context_manager_stops_server_and_frees_port():
    scene = build_scene(batch_size=1)
    host = "127.0.0.1"
    with scene.show(host=host, preferred_port=6013) as handle:
        port = handle._threaded.port
        # Port must be bound (in use) while the viewer is up.
        assert not _port_is_free(host, port)

    # After exiting the context manager, the port must be released.
    assert _port_is_free(host, port)


def test_concurrent_shows_get_independent_ports():
    scene_a = build_scene(batch_size=1)
    scene_b = build_scene(batch_size=1)
    handle_a = scene_a.show(preferred_port=6014)
    try:
        handle_b = scene_b.show(preferred_port=6014)
        try:
            assert handle_a.url != handle_b.url
            assert httpx.get(f"{handle_a.url}/model", timeout=5.0).status_code == 200
            assert httpx.get(f"{handle_b.url}/model", timeout=5.0).status_code == 200
        finally:
            handle_b.stop()
    finally:
        handle_a.stop()
