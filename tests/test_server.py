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


def test_missing_file_in_multi_path_list_raises(tmp_path):
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)
    with pytest.raises(FileNotFoundError):
        SimViewServer.start(sim_path=[sim_file, tmp_path / "does-not-exist.json"])


def test_server_accepts_preloaded_data():
    server = SimViewServer(data={"model": {"simBatches": 1}, "states": []})
    client = TestClient(server.app)
    resp = client.get("/model")
    assert resp.json()["simBatches"] == 1


def test_server_requires_at_least_one_of_sim_path_or_data():
    with pytest.raises(ValueError, match="sim_path.*data"):
        SimViewServer()


def test_server_accepts_both_sim_path_and_data(tmp_path):
    # Used by the multi-file merge path: sim_path carries the original file(s) for
    # deriving where to persist custom batch names, while data is the already-merged
    # payload to actually serve.
    scene = build_scene(batch_size=1)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)
    server = SimViewServer(
        sim_path=sim_file, data={"model": {"simBatches": 1}, "states": []}
    )
    client = TestClient(server.app)
    resp = client.get("/model")
    assert resp.json()["simBatches"] == 1


def test_batch_names_endpoint_persists_and_reloads(tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    server = SimViewServer(sim_path=sim_file)
    client = TestClient(server.app)
    resp = client.post("/batch-names", json={"names": ["real", "sim"]})
    assert resp.status_code == 200
    assert client.get("/model").json()["batchNames"] == ["real", "sim"]

    # A fresh server instance for the same file should pick up the saved names.
    reloaded = SimViewServer(sim_path=sim_file)
    reloaded_client = TestClient(reloaded.app)
    assert reloaded_client.get("/model").json()["batchNames"] == ["real", "sim"]


def test_batch_names_endpoint_rejects_wrong_length(tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)
    server = SimViewServer(sim_path=sim_file)
    client = TestClient(server.app)
    resp = client.post("/batch-names", json={"names": ["only-one"]})
    assert resp.status_code == 400
