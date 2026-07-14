"""Tests for simview.launcher (bug B8: exceptions from the server must not be
swallowed -- the caller should learn the server crashed, while cleanup and
KeyboardInterrupt handling stay graceful)."""

import logging

import pytest

pytest.importorskip("torch")

from conftest import build_scene

import simview.launcher as launcher_module
from simview.launcher import SimViewLauncher


def test_launch_reraises_after_cleanup(monkeypatch, caplog):
    scene = build_scene(batch_size=1)
    launcher = SimViewLauncher(scene)

    cleanup_calls = []
    monkeypatch.setattr(launcher, "cleanup", lambda: cleanup_calls.append(True))

    def _boom(*args, **kwargs):
        raise RuntimeError("server exploded")

    monkeypatch.setattr(launcher_module.SimViewServer, "run", _boom)

    with caplog.at_level(logging.ERROR, logger="simview.launcher"):
        with pytest.raises(RuntimeError, match="server exploded"):
            launcher.launch()

    # cleanup must still run even though the exception propagates
    assert cleanup_calls == [True]
    assert "Error starting SimView server" in caplog.text


def test_launch_handles_keyboard_interrupt_gracefully(monkeypatch, caplog):
    scene = build_scene(batch_size=1)
    launcher = SimViewLauncher(scene)

    cleanup_calls = []
    monkeypatch.setattr(launcher, "cleanup", lambda: cleanup_calls.append(True))

    def _interrupt(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(launcher_module.SimViewServer, "run", _interrupt)

    with caplog.at_level(logging.INFO, logger="simview.launcher"):
        launcher.launch()  # should not raise

    assert cleanup_calls == [True]
    assert "stopped by user" in caplog.text


# --- In-memory scene handoff to the server -----------------------------------


def test_launch_passes_in_memory_scene_data_to_server(monkeypatch):
    scene = build_scene(batch_size=2)
    expected_model = scene.model.to_json()
    expected_states = list(scene.states)
    launcher = SimViewLauncher(scene)

    received = {}

    class _FakeServer:
        def __init__(self, data=None, sim_path=None):
            received["data"] = data

        def run(self, host, port):
            pass

    monkeypatch.setattr(launcher_module, "SimViewServer", _FakeServer)

    launcher.launch()

    assert received["data"]["model"] == expected_model
    assert received["data"]["states"] == expected_states


def test_launch_with_file_path_does_not_construct_data_kwarg(monkeypatch, tmp_path):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    launcher = SimViewLauncher(sim_file)
    calls = []
    monkeypatch.setattr(
        launcher_module.SimViewServer,
        "start",
        staticmethod(lambda **kw: calls.append(kw)),
    )

    launcher.launch()

    assert calls == [
        {"sim_path": sim_file, "host": "127.0.0.1", "preferred_port": 5420}
    ]


# --- Cleanup semantics ---------------------------------------------------------


def test_cleanup_is_idempotent_and_clears_scene():
    scene = build_scene(batch_size=1)
    launcher = SimViewLauncher(scene)

    launcher.cleanup()
    assert launcher._scene is None
    assert scene.states == []  # _clear_internal_data ran

    # Calling again must not raise (guarded by `if self._scene is not None`).
    launcher.cleanup()
    assert launcher._scene is None


def test_context_manager_calls_cleanup_on_exit():
    scene = build_scene(batch_size=1)
    with SimViewLauncher(scene) as launcher:
        assert launcher._scene is scene
    assert launcher._scene is None
    assert scene.states == []


# --- Constructor validation -----------------------------------------------------


def test_constructor_rejects_incomplete_scene():
    from simview.scene import SimulationScene

    incomplete = SimulationScene(batch_size=1, scalar_names=[], dt=0.1)  # no terrain
    with pytest.raises(ValueError, match="incomplete"):
        SimViewLauncher(incomplete)


def test_constructor_rejects_missing_file(tmp_path):
    missing = tmp_path / "does-not-exist.json"
    with pytest.raises(FileNotFoundError):
        SimViewLauncher(missing)


def test_constructor_rejects_unsupported_source_type():
    with pytest.raises(TypeError, match="SimulationScene object or a file path"):
        SimViewLauncher(12345)  # type: ignore[arg-type]  # deliberately wrong type to test runtime validation
