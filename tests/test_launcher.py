"""Tests for simview.launcher (bug B8: exceptions from the server must not be
swallowed -- the caller should learn the server crashed, while cleanup and
KeyboardInterrupt handling stay graceful)."""

import logging

import pytest
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
