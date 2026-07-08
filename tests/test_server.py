import pytest
from conftest import build_scene
from fastapi.testclient import TestClient

from simview.server import SimViewServer


@pytest.fixture
def client(tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)
    server = SimViewServer(sim_path=sim_file)
    return TestClient(server.app)


def test_model_endpoint_serves_gzipped_json(client):
    resp = client.get("/model")
    assert resp.status_code == 200
    # TestClient transparently decompresses; verify it is valid JSON.
    model = resp.json()
    assert model["simBatches"] == 2


def test_states_endpoint_serves_gzipped_json(client):
    resp = client.get("/states")
    assert resp.status_code == 200
    assert len(resp.json()) == 3


def test_payload_advertises_gzip_encoding(client):
    # The endpoint always serves pre-compressed bytes with a gzip Content-Encoding
    # header; the HTTP client (httpx) transparently decodes it back to JSON.
    resp = client.get("/model")
    assert resp.headers["content-encoding"] == "gzip"
    assert resp.json()["simBatches"] == 2


def test_missing_file_raises():
    with pytest.raises(FileNotFoundError):
        SimViewServer.start(sim_path="does-not-exist.json")
