import json
import os
import re

import pytest

pytest.importorskip("torch")

from conftest import build_scene
from fastapi import FastAPI
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
    # build_scene's states are consistent across frames, so they're served as
    # the columnar v4 payload (see test_columnar_states.py), not a bare array.
    body = resp.json()
    assert body["version"] == 4
    assert len(body["times"]) == 3


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


def test_server_serves_empty_states_list(tmp_path):
    scene = build_scene(batch_size=1)
    scene.states = []  # simulate a scene saved before any add_state call
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    server = SimViewServer(sim_path=sim_file)
    client = TestClient(server.app)
    resp = client.get("/states")
    assert resp.status_code == 200
    assert resp.json() == []


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


def test_stale_batch_names_ignored_after_source_file_regenerated(tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    server = SimViewServer(sim_path=sim_file)
    client = TestClient(server.app)
    resp = client.post("/batch-names", json={"names": ["real", "sim"]})
    assert resp.status_code == 200

    # Regenerate the source file, as a fresh experiment run would - same shape,
    # different content, and (forced here to dodge mtime-resolution flakiness)
    # a later mtime.
    build_scene(batch_size=2).save(sim_file)
    newer = sim_file.stat().st_mtime + 10
    os.utime(sim_file, (newer, newer))

    reloaded = SimViewServer(sim_path=sim_file)
    reloaded_client = TestClient(reloaded.app)
    model = reloaded_client.get("/model").json()
    assert model.get("batchNames") != ["real", "sim"]


def test_batch_names_endpoint_rejects_wrong_length(tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)
    server = SimViewServer(sim_path=sim_file)
    client = TestClient(server.app)
    resp = client.post("/batch-names", json={"names": ["only-one"]})
    assert resp.status_code == 400


# --- Gzip support (gameplan item 16) -----------------------------------------


def test_serves_gzipped_scene_file(tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json.gz"
    scene.save(sim_file, compress=True)

    server = SimViewServer(sim_path=sim_file)
    client = TestClient(server.app)

    model = client.get("/model").json()
    assert model["simBatches"] == 2
    assert len(client.get("/states").json()["times"]) == 3


# --- Server hardening (gameplan item 10 / bug B7) ----------------------------


def test_batch_names_endpoint_rejects_malformed_body(tmp_path):
    # Pydantic model validation: "names" must be a list of strings, not e.g. ints
    # or a missing field entirely. Both should fail request validation (422),
    # distinct from the semantic "wrong length" case which stays a 400.
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)
    server = SimViewServer(sim_path=sim_file)
    client = TestClient(server.app)

    resp = client.post("/batch-names", json={"names": [1, 2]})
    assert resp.status_code == 422

    resp = client.post("/batch-names", json={})
    assert resp.status_code == 422

    resp = client.post("/batch-names", json={"names": "not-a-list"})
    assert resp.status_code == 422


def test_cors_header_present_for_allowed_origin(client):
    resp = client.get("/model", headers={"Origin": "http://localhost:3000"})
    assert resp.headers["access-control-allow-origin"] == "http://localhost:3000"


def test_cors_header_absent_for_disallowed_origin(client):
    resp = client.get("/model", headers={"Origin": "http://evil.example.com"})
    assert "access-control-allow-origin" not in resp.headers


def test_static_assets_carry_cache_control_header(client):
    resp = client.get("/static/js/main.js")
    assert resp.status_code == 200
    assert "max-age" in resp.headers["cache-control"]


def test_vendored_static_libs_are_marked_immutable(client):
    resp = client.get("/static/lib/js-colormaps.js")
    assert resp.status_code == 200
    assert "immutable" in resp.headers["cache-control"]


def test_blob_response_carries_immutable_cache_control_header(client):
    # Blob URLs are versioned by a per-load token (see _load_data), so once
    # served for this instance's lifetime they never change and can be cached
    # forever -- discover a real one from /model rather than hardcoding an id.
    model = client.get("/model").json()
    blob_ref = model["terrain"]["heightData"]
    assert blob_ref.startswith("/blob/")

    resp = client.get(blob_ref)
    assert resp.status_code == 200
    assert "immutable" in resp.headers["cache-control"]


def test_blob_endpoint_404s_for_wrong_token(client):
    model = client.get("/model").json()
    blob_ref = model["terrain"]["heightData"]
    _, _, token, blob_id = blob_ref.split("/")

    resp = client.get(f"/blob/wrong{token}/{blob_id}")
    assert resp.status_code == 404


def test_importmap_is_fully_vendored_offline(client):
    # The viewer must work with no internet access: every specifier in the
    # importmap on the served index page must resolve to a same-origin
    # /static/... path (never a third-party CDN URL like
    # https://cdn.jsdelivr.net/...), and each of those paths must actually be
    # served (200) -- see README "License and Third-Party Notices" and the
    # comment above the importmap in index.html.
    resp = client.get("/")
    assert resp.status_code == 200
    match = re.search(r'<script type="importmap">(.*?)</script>', resp.text, re.S)
    assert match, "index.html must contain an importmap <script> block"
    importmap = json.loads(match.group(1))
    imports = importmap["imports"]
    assert imports, "importmap must declare at least one import specifier"

    # index.html writes every specifier as a page-relative "./static/..."
    # path (so the page can be served from any path), which always resolves
    # same-origin -- unlike an absolute CDN URL (e.g.
    # https://cdn.jsdelivr.net/...), which this guards against.
    prefix_urls = {}
    for specifier, url in imports.items():
        assert url.startswith("./static/"), (
            f"importmap specifier {specifier!r} does not resolve to a local "
            f"./static/ path (got {url!r}) -- third-party libraries must be "
            "vendored, not CDN-loaded"
        )
        path = url[1:]
        # Bare-prefix specifiers (e.g. "three/addons/") map to a directory,
        # not a file -- there's nothing meaningful to fetch at the bare
        # directory URL itself, so only check specifiers mapping to an
        # actual file. Remember the prefix so the addon files actually
        # imported by our JS (checked below) can be resolved against it.
        if path.endswith("/"):
            prefix_urls[specifier] = path
            continue
        follow_up = client.get(path)
        assert follow_up.status_code == 200, (
            f"importmap specifier {specifier!r} -> {path!r} did not resolve (got "
            f"{follow_up.status_code})"
        )

    # The addon files our JS actually imports via the "three/addons/" prefix
    # (OrbitControls in Scene.js, lil-gui in Controls.js) must
    # also resolve, not just the bare prefix.
    addons_prefix = prefix_urls.get("three/addons/")
    assert addons_prefix, "importmap must declare a 'three/addons/' prefix"
    for addon_path in (
        "controls/OrbitControls.js",
        "libs/lil-gui.module.min.js",
    ):
        resp = client.get(addons_prefix + addon_path)
        assert resp.status_code == 200, (
            f"addon {addon_path!r} did not resolve under {addons_prefix!r}"
        )


def test_cached_scene_bytes_correct_after_batch_names_mutation(tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)
    server = SimViewServer(sim_path=sim_file)
    client = TestClient(server.app)

    before = client.get("/model").json()
    assert "batchNames" not in before or before.get("batchNames") != ["a", "b"]

    resp = client.post("/batch-names", json={"names": ["a", "b"]})
    assert resp.status_code == 200

    after = client.get("/model").json()
    assert after["batchNames"] == ["a", "b"]
    # simBatches and other fields must still be intact after the cached bytes
    # were re-serialized in place.
    assert after["simBatches"] == 2


def test_batch_names_response_reports_persistence(tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    on_disk = TestClient(SimViewServer(sim_path=sim_file).app)
    assert on_disk.post("/batch-names", json={"names": ["a", "b"]}).json() == {
        "ok": True,
        "persisted": True,
    }
    # In-memory scenes (show()/LiveViewer/render) have no sidecar to write.
    in_memory = TestClient(
        SimViewServer(data={"model": scene.model.to_json(), "states": scene.states}).app
    )
    assert in_memory.post("/batch-names", json={"names": ["a", "b"]}).json() == {
        "ok": True,
        "persisted": False,
    }


def test_batch_names_sidecar_is_keyed_by_batch_selection(tmp_path):
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)
    data = {"model": scene.model.to_json(), "states": scene.states}

    a = SimViewServer(data=data, sim_path=[sim_file], batch_selections=["0"])
    b = SimViewServer(data=data, sim_path=[sim_file], batch_selections=["1"])
    assert a._names_sidecar_path() != b._names_sidecar_path()


def test_batch_names_fingerprint_is_taken_at_load_time(tmp_path):
    """A file regenerated between load and rename must invalidate the sidecar
    on the next load: the names described the *old* batches."""
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)
    server = SimViewServer(sim_path=sim_file)
    client = TestClient(server.app)

    scene.save(sim_file)
    os.utime(sim_file, (1, 1))  # "regenerated" after load
    assert client.post("/batch-names", json={"names": ["a", "b"]}).status_code == 200

    reloaded = TestClient(SimViewServer(sim_path=sim_file).app).get("/model").json()
    assert reloaded.get("batchNames") != ["a", "b"]


def test_multiple_sim_paths_without_merged_data_is_rejected(tmp_path):
    scene = build_scene(batch_size=2)
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    scene.save(a)
    scene.save(b)
    with pytest.raises(ValueError):
        SimViewServer(sim_path=[a, b])


def test_metadata_strings_starting_with_blob_prefix_are_not_rewritten():
    scene = build_scene(batch_size=2)
    data = {"model": scene.model.to_json(), "states": scene.states}
    data["model"]["metadata"] = {"note": "__b64__not a blob"}
    data["model"]["batchNames"] = ["__b64__x", "y"]
    model = TestClient(SimViewServer(data=data).app).get("/model").json()
    assert model["metadata"] == {"note": "__b64__not a blob"}
    assert model["batchNames"] == ["__b64__x", "y"]


def test_static_files_served_through_a_symlinked_install(tmp_path):
    """Starlette realpaths the file; our Cache-Control subclass must compare
    against the realpath'd directory too, or every asset 500s."""
    from simview.server import STATIC, CacheControlStaticFiles

    link = tmp_path / "static_link"
    link.symlink_to(STATIC)
    app = FastAPI()
    app.mount("/static", CacheControlStaticFiles(directory=str(link)))
    resp = TestClient(app).get("/static/js/main.js")
    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "public, max-age=60"


def test_viewer_handle_startup_timeout_tells_the_server_to_exit(monkeypatch):
    import threading

    import simview.server as server_module

    started = threading.Event()
    servers = []

    def _never_starts(self):
        servers.append(self)
        started.wait(5)

    monkeypatch.setattr(server_module.uvicorn.Server, "run", _never_starts)
    monkeypatch.setattr(server_module, "_START_TIMEOUT", 0.05)
    with pytest.raises(TimeoutError):
        server_module.ViewerHandle(FastAPI())
    started.set()
    # The handle never came back, so this is the only way the port gets freed.
    assert servers[0].should_exit


def test_start_applies_batch_selection_to_a_single_file(monkeypatch, tmp_path):
    """A batch selection routes even one file through the merge path, so the
    served scene holds only the selected batches."""
    scene = build_scene(batch_size=3)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    served = []
    monkeypatch.setattr(
        SimViewServer, "run", lambda self, **kw: served.append(self.model_data)
    )
    SimViewServer.start(sim_path=sim_file, batch_selections=["0,2"])

    assert served[0]["simBatches"] == 2
    assert served[0]["batchNames"] == ["sim[0]", "sim[2]"]
