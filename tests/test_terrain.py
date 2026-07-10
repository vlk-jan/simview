"""Tests for terrain batch/singleton handling in create_terrain."""

import base64
import struct

import pytest
import torch

from simview.scene import SimulationScene


def _flat(blob: str) -> list[float]:
    assert blob.startswith("__b64__")
    raw = base64.b64decode(blob[7:])
    return list(struct.unpack(f"<{len(raw) // 4}f", raw))


def _terrain(batch_size, h_batches, n_batches):
    res = 3
    scene = SimulationScene(batch_size=batch_size, scalar_names=[], dt=0.1)
    heights = torch.arange(h_batches * res * res, dtype=torch.float32).reshape(
        h_batches, res, res
    )
    normals = torch.zeros(n_batches, 3, res, res)
    normals[:, 2] = 1.0
    scene.create_terrain(
        heightmap=heights, normals=normals, x_lim=(-1, 1), y_lim=(-1, 1)
    )
    return scene.model.terrain, res


def test_shared_terrain_is_singleton_and_broadcast():
    terrain, res = _terrain(batch_size=3, h_batches=1, n_batches=1)
    assert terrain.is_singleton is True
    # Broadcast to batch_size so the viewer (which splits by batch_size) is happy.
    assert len(_flat(terrain.height_data)) == 3 * res * res


def test_mixed_shared_and_per_batch_is_not_singleton():
    # Shared height (1) + per-batch normals (3): previously this was mislabeled
    # singleton; now it's a consistent non-singleton with height broadcast.
    terrain, res = _terrain(batch_size=3, h_batches=1, n_batches=3)
    assert terrain.is_singleton is False
    assert len(_flat(terrain.height_data)) == 3 * res * res
    assert len(_flat(terrain.normals)) == 3 * res * res * 3


def test_per_batch_terrain_is_not_singleton():
    terrain, _ = _terrain(batch_size=2, h_batches=2, n_batches=2)
    assert terrain.is_singleton is False


def test_single_batch_is_not_singleton():
    terrain, _ = _terrain(batch_size=1, h_batches=1, n_batches=1)
    assert terrain.is_singleton is False


def test_invalid_batch_dim_raises():
    with pytest.raises(ValueError, match="batch dim"):
        _terrain(batch_size=3, h_batches=2, n_batches=3)  # 2 is neither 1 nor 3
