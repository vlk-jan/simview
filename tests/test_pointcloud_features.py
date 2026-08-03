"""Tests for per-point color/embedding on point clouds and the terrain
embedding channel (WaffleIron-feature interactive-viewer support)."""

import base64
import struct

import pytest

torch = pytest.importorskip("torch")

from simview.model import BodyShapeType, SimViewBody
from simview.scene import SimulationScene


def _flat(blob: str) -> list[float]:
    assert blob.startswith("__b64__")
    raw = base64.b64decode(blob[7:])
    return list(struct.unpack(f"<{len(raw) // 4}f", raw))


def test_create_pointcloud_color_shape_mismatch_raises():
    points = torch.zeros(10, 3)
    color = torch.zeros(9, 3)
    with pytest.raises(ValueError, match="color must have shape"):
        SimViewBody.create_pointcloud("pts", points, color=color)


def test_create_pointcloud_embedding_shape_mismatch_raises():
    points = torch.zeros(10, 3)
    embedding = torch.zeros(9, 5)
    with pytest.raises(ValueError, match="embedding must have shape"):
        SimViewBody.create_pointcloud("pts", points, embedding=embedding)


def test_create_pointcloud_points_wrong_shape_raises():
    with pytest.raises(ValueError, match="points must have shape"):
        SimViewBody.create_pointcloud("pts", torch.zeros(10, 4))


def test_create_pointcloud_color_and_embedding_roundtrip():
    N, K = 5, 3
    points = torch.arange(N * 3, dtype=torch.float32).reshape(N, 3)
    color = torch.rand(N, 3)
    embedding = torch.arange(N * K, dtype=torch.float32).reshape(N, K)
    body = SimViewBody.create_pointcloud(
        "pts", points, color=color, embedding=embedding
    )
    assert body.shape["type"] == BodyShapeType.POINTCLOUD.value
    decoded_points = _flat(body.shape["points"])
    decoded_color = _flat(body.shape["color"])
    decoded_embedding = _flat(body.shape["embedding"])
    assert decoded_points == pytest.approx(points.flatten().tolist())
    assert decoded_color == pytest.approx(color.flatten().tolist())
    assert decoded_embedding == pytest.approx(embedding.flatten().tolist())


def test_create_pointcloud_without_color_or_embedding_omits_keys():
    body = SimViewBody.create_pointcloud("pts", torch.zeros(4, 3))
    assert "color" not in body.shape
    assert "embedding" not in body.shape


def test_scene_create_pointcloud_adds_body():
    scene = SimulationScene(batch_size=1, scalar_names=[], dt=0.1)
    scene.create_pointcloud("pts", torch.zeros(4, 3), color=torch.zeros(4, 3))
    assert "pts" in scene.model.bodies
    assert scene.model.bodies["pts"].shape["type"] == BodyShapeType.POINTCLOUD.value


def test_scene_create_pointcloud_duplicate_name_raises():
    scene = SimulationScene(batch_size=1, scalar_names=[], dt=0.1)
    scene.create_pointcloud("pts", torch.zeros(4, 3))
    with pytest.raises(ValueError, match="already exists"):
        scene.create_pointcloud("pts", torch.zeros(4, 3))


def test_create_terrain_embedding_map_roundtrips():
    res, K = 3, 4
    scene = SimulationScene(batch_size=1, scalar_names=[], dt=0.1)
    heights = torch.zeros(1, res, res)
    normals = torch.zeros(1, 3, res, res)
    normals[:, 2] = 1.0
    embedding_map = torch.arange(K * res * res, dtype=torch.float32).reshape(
        1, K, res, res
    )
    scene.create_terrain(
        heightmap=heights,
        normals=normals,
        x_lim=(-1, 1),
        y_lim=(-1, 1),
        embedding_map=embedding_map,
    )
    terrain = scene.model.terrain
    assert terrain is not None
    assert terrain.embedding_data is not None
    decoded = _flat(terrain.embedding_data)
    # Encoded as (b, (d1 d2), k): reshape back and compare against the
    # channels-first (b, k, d1, d2) input via a permute.
    decoded_t = torch.tensor(decoded).reshape(1, res * res, K)
    expected = embedding_map.reshape(1, K, res * res).permute(0, 2, 1)
    assert torch.allclose(decoded_t, expected)


def test_create_terrain_embedding_map_batch_dim_validation():
    res, K = 3, 2
    scene = SimulationScene(batch_size=3, scalar_names=[], dt=0.1)
    heights = torch.zeros(1, res, res)
    bad_embedding = torch.zeros(2, K, res, res)  # neither 1 nor batch_size(3)
    with pytest.raises(ValueError, match="embedding_map"):
        scene.create_terrain(
            heightmap=heights, x_lim=(-1, 1), y_lim=(-1, 1), embedding_map=bad_embedding
        )


def test_create_terrain_embedding_map_broadcasts_shared_batch():
    res, K, B = 3, 2, 3
    scene = SimulationScene(batch_size=B, scalar_names=[], dt=0.1)
    heights = torch.zeros(1, res, res)
    embedding_map = torch.ones(1, K, res, res)  # shared across all batches
    scene.create_terrain(
        heightmap=heights, x_lim=(-1, 1), y_lim=(-1, 1), embedding_map=embedding_map
    )
    terrain = scene.model.terrain
    assert terrain is not None
    decoded = _flat(terrain.embedding_data)
    assert len(decoded) == B * res * res * K


def test_create_terrain_without_embedding_map_key_is_none():
    scene = SimulationScene(batch_size=1, scalar_names=[], dt=0.1)
    scene.create_terrain(heightmap=torch.zeros(1, 3, 3), x_lim=(-1, 1), y_lim=(-1, 1))
    assert scene.model.terrain is not None
    assert scene.model.terrain.embedding_data is None
    assert scene.model.terrain.to_json()["embeddingData"] is None
