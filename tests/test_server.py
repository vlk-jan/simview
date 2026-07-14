import hashlib
import json
import os
import re
import urllib.parse

import pytest

pytest.importorskip("torch")

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


def test_legacy_bare_list_sidecar_still_applied(tmp_path):
    # Sidecars written before fingerprinting was added are a bare JSON list with
    # no way to check staleness; they must keep working rather than being
    # silently discarded.
    scene = build_scene(batch_size=2)
    sim_file = tmp_path / "sim.json"
    scene.save(sim_file)

    key = hashlib.sha1(str(sim_file.resolve()).encode()).hexdigest()[:10]
    sidecar = sim_file.parent / f".{sim_file.stem}.{key}.batchnames.json"
    sidecar.write_text(json.dumps(["legacy-a", "legacy-b"]))

    server = SimViewServer(sim_path=sim_file)
    client = TestClient(server.app)
    assert client.get("/model").json()["batchNames"] == ["legacy-a", "legacy-b"]


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
    resp = client.get("/static/lib/tar.js")
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

    # url_for() always renders an absolute URL (http://testserver/... under
    # TestClient), so "no CDN URL" is checked as "same origin as this
    # request", not "no http(s) prefix at all".
    origin = urllib.parse.urlsplit(str(resp.url))
    same_origin_prefix = f"{origin.scheme}://{origin.netloc}"

    prefix_urls = {}
    for specifier, url in imports.items():
        assert url.startswith(same_origin_prefix + "/static/"), (
            f"importmap specifier {specifier!r} does not resolve to a local "
            f"/static/ path (got {url!r}) -- third-party libraries must be "
            "vendored, not CDN-loaded"
        )
        path = url[len(same_origin_prefix) :]
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
    # (OrbitControls in InteractionControls.js, lil-gui in Controls.js) must
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
