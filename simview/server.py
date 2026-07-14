import asyncio
import base64
import gzip
import hashlib
import json
import logging
import secrets
import time
from collections.abc import Sequence
from contextlib import asynccontextmanager
from pathlib import Path

try:
    import orjson
except ImportError:
    orjson = None

try:
    import numpy as np
except ImportError:
    np = None

from importlib.resources import files

import uvicorn
from fastapi import FastAPI, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from starlette.types import Scope

from simview.utils import find_free_port, read_maybe_gzipped_bytes

logger = logging.getLogger("simview.server")

TEMPLATES = str(files("simview").joinpath("templates"))
STATIC = str(files("simview").joinpath("static"))

# Local-only viewer: CORS is restricted to localhost/127.0.0.1 on any port so a
# browser tab open on another local dev server can't be silently allowed, while
# still letting the bundled UI (served from the same host) talk to the API.
_ALLOWED_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"

# Subdirectories of simview/static that hold vendored, version-pinned third-party
# libraries. These never change for a given release, so they get a long-lived,
# immutable cache header. Everything else under /static (our own JS/CSS/textures)
# is cache-busted via the ?v= query param in index.html instead, so it only needs
# a short revalidation window.
_IMMUTABLE_STATIC_DIRS = ("lib/",)

# Per-body numeric state fields eligible for columnar (whole-trajectory) binary
# packing, with their trailing per-batch-row width. Same fields/widths
# SimViewBodyState/add_trajectory may binary-encode per frame (state.py,
# blobCodec.js) -- the columnar repack below just packs a whole (T, B, k) run
# instead of one (B, k) blob per frame.
_STATE_FIELD_WIDTHS = {
    "bodyTransform": 7,
    "velocity": 3,
    "angularVelocity": 3,
    "force": 3,
    "torque": 3,
}


class _StatesShapeMismatch(Exception):
    """Raised internally by _columnarize_states to bail out to the legacy
    array response -- caught in one place rather than threading a bunch of
    `if inconsistent: return None` checks through the nested loops below."""


def _decode_state_field_rows(value, width: int, batch_size: int):
    """Decode one state's per-body field value (either a `__b64__` blob or a
    plain nested/flat JSON list) into a (batch_size, width) float32 array.

    Mirrors the shapes SimViewBodyState.to_json()/add_trajectory produce: a
    `__b64__` blob is always batch_size rows of `width` floats; a plain list is
    either already nested (one row per batch) or, for a single-batch scene, a
    flat list of `width` floats (see README "Authoring whole trajectories").
    """
    assert np is not None
    if isinstance(value, str):
        if not value.startswith("__b64__"):
            raise _StatesShapeMismatch(f"unexpected string value for field: {value!r}")
        flat = np.frombuffer(base64.b64decode(value[7:]), dtype="<f4")
    else:
        arr = np.asarray(value, dtype="<f4")
        if arr.ndim == 1:
            if batch_size != 1:
                raise _StatesShapeMismatch(
                    "flat (non-nested) field value with batch size != 1"
                )
            arr = arr[None, :]
        flat = arr.reshape(-1)
    if flat.size != batch_size * width:
        raise _StatesShapeMismatch(
            f"field has {flat.size} floats; expected {batch_size * width} "
            f"({batch_size} batches x {width})"
        )
    return flat.reshape(batch_size, width)


def _body_key(name):
    """Hashable key for a body's `name` (a string, or a list of grouped names
    for bodies moving rigidly together -- see BodyTrajectory/SimViewBodyState).
    The original `name` value (str or list) is what actually gets emitted in
    the columnar payload; this is only used to identify "the same body slot"
    across frames."""
    return tuple(name) if isinstance(name, list) else name


def _columnarize_states(states_data: list, model_data: dict | None, register_blob):
    """Repack the legacy per-frame `states` array into the columnar v4 payload
    described in README.md, or return None if `states_data` doesn't meet the
    strict consistency requirements (in which case the caller must fall back
    to serving `states_data` exactly as today).

    `register_blob(bytes) -> url` registers one whole-trajectory float32 blob
    (e.g. in self.blobs) and returns its `/blob/{token}/{id}` URL.

    Strict by design: this trades a bit of coverage (an inconsistent scene
    just doesn't get the perf win) for never risking a subtly wrong repack
    reaching the viewer. The one deliberate exception is `contacts`, which may
    legitimately come and go per frame (see README) without disqualifying the
    rest of the scene from columnar packing.
    """
    if np is None or not states_data:
        return None
    if model_data is None:
        return None

    batch_size = int(model_data.get("simBatches", 1))

    try:
        times = []
        # Per body: ordered list of field names (first frame's order/set is
        # the contract every other frame must match), plus the accumulated
        # (T, B, k) rows for each field, and the original name value to emit.
        body_order: list = []
        body_fields: dict[object, list[str]] = {}
        body_name_value: dict[object, object] = {}
        body_rows: dict[object, dict[str, list]] = {}
        body_contacts: dict[object, list] = {}
        any_contacts: set = set()

        for state_idx, state in enumerate(states_data):
            if "time" not in state:
                raise _StatesShapeMismatch(f"state {state_idx} is missing 'time'")
            times.append(state["time"])

            bodies = state.get("bodies") or []
            seen_keys = set()
            for body in bodies:
                if not isinstance(body, dict) or "name" not in body:
                    raise _StatesShapeMismatch(
                        f"state {state_idx} has a body entry missing 'name'"
                    )
                name = body["name"]
                if not isinstance(name, (str, list)):
                    raise _StatesShapeMismatch(
                        f"state {state_idx} has a non-string/list body name"
                    )
                key = _body_key(name)
                if key in seen_keys:
                    raise _StatesShapeMismatch(
                        f"state {state_idx} lists body '{name}' more than once"
                    )
                seen_keys.add(key)

                fields = sorted(k for k in body if k in _STATE_FIELD_WIDTHS)
                if key not in body_fields:
                    if state_idx != 0 and body_rows.get(key) is None:
                        # A body appearing for the first time after frame 0
                        # would leave earlier frames' rows undefined -- bail
                        # rather than guess a fill value.
                        raise _StatesShapeMismatch(
                            f"body '{name}' first appears at state {state_idx}, "
                            "not state 0"
                        )
                    body_order.append(key)
                    body_fields[key] = fields
                    body_name_value[key] = name
                    body_rows[key] = {f: [] for f in fields}
                elif body_fields[key] != fields:
                    raise _StatesShapeMismatch(
                        f"body '{name}' has inconsistent field set across frames"
                    )

                for field in fields:
                    width = _STATE_FIELD_WIDTHS[field]
                    rows = _decode_state_field_rows(body[field], width, batch_size)
                    body_rows[key][field].append(rows)

                if "contacts" in body:
                    any_contacts.add(key)
                    body_contacts.setdefault(key, [None] * state_idx).append(
                        body["contacts"]
                    )
                elif key in any_contacts:
                    body_contacts[key].append(None)

            missing = set(body_order) - seen_keys
            if missing:
                raise _StatesShapeMismatch(
                    f"state {state_idx} is missing bodies present in earlier "
                    f"frames: {sorted(str(m) for m in missing)}"
                )
            # A body with contacts not yet seen this frame (declared later than
            # its own first appearance) still needs a None placeholder so its
            # contacts list stays length == number of frames seen so far.
            for key in any_contacts:
                lst = body_contacts[key]
                if len(lst) < state_idx + 1:
                    lst.append(None)

            scalar_names = model_data.get("scalarNames") or []
            for name in scalar_names:
                if name not in state:
                    raise _StatesShapeMismatch(
                        f"state {state_idx} is missing scalar '{name}'"
                    )

        T = len(states_data)

        bodies_payload = []
        for key in body_order:
            fields_payload = {}
            for field, per_frame_rows in body_rows[key].items():
                if len(per_frame_rows) != T:
                    raise _StatesShapeMismatch(
                        f"body '{body_name_value[key]}' field '{field}' is "
                        "missing from some frames"
                    )
                stacked = np.ascontiguousarray(
                    np.stack(per_frame_rows, axis=0), dtype="<f4"
                )  # (T, B, k)
                fields_payload[field] = register_blob(stacked.tobytes())
            entry = {"name": body_name_value[key], "fields": fields_payload}
            if key in any_contacts:
                entry["contacts"] = body_contacts[key]
            bodies_payload.append(entry)

        scalars_payload = {}
        for name in model_data.get("scalarNames") or []:
            per_frame = []
            for state in states_data:
                row = np.asarray(state[name], dtype="<f4")
                if row.ndim == 0:
                    row = row.reshape(1)
                if row.shape != (batch_size,):
                    raise _StatesShapeMismatch(
                        f"scalar '{name}' has shape {row.shape}; expected "
                        f"({batch_size},)"
                    )
                per_frame.append(row)
            stacked = np.ascontiguousarray(np.stack(per_frame, axis=0), dtype="<f4")
            scalars_payload[name] = register_blob(stacked.tobytes())

        return {
            "version": 4,
            "times": times,
            "bodies": bodies_payload,
            "scalars": scalars_payload,
        }
    except _StatesShapeMismatch as e:
        logger.warning(
            "States data is not columnar-repackable, falling back to the "
            "legacy per-frame array response: %s",
            e,
        )
        return None


class BatchNamesRequest(BaseModel):
    names: list[str]


class CacheControlStaticFiles(StaticFiles):
    """StaticFiles that adds a Cache-Control header based on the asset's path."""

    def file_response(
        self, full_path, stat_result, scope: Scope, status_code: int = 200
    ):
        response = super().file_response(full_path, stat_result, scope, status_code)
        # full_path is the absolute filesystem path of the matched file; check it
        # (rather than scope["path"]) since the latter is mount-relative and its
        # exact shape depends on how the StaticFiles app was mounted.
        # self.directory is set from the `directory=` kwarg we always pass to
        # StaticFiles.__init__ (see the mount() call below), so it's never None
        # here even though the base class types it as Optional for callers that
        # use `packages=` instead.
        assert self.directory is not None
        rel_path = Path(full_path).relative_to(self.directory).as_posix()
        if rel_path.startswith(_IMMUTABLE_STATIC_DIRS):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "public, max-age=60"
        return response


class SimViewServer:
    def __init__(
        self,
        sim_path: str | Path | Sequence[str | Path] | None = None,
        data: dict | None = None,
        live: bool = False,
    ):
        if sim_path is None and data is None:
            raise ValueError("Provide 'sim_path' and/or 'data'")
        # Live streaming mode (see simview.live.LiveViewer): /states reports
        # {"live": true} instead of serving a (possibly empty) states array,
        # and a /ws/states endpoint is registered to push frames as they're
        # produced. self.ws_clients is only ever mutated on self.loop (set by
        # LiveViewer once the server thread's event loop is running) so
        # push_state's broadcast, running on the caller's thread, never races
        # a client connecting/disconnecting on the server thread.
        self.live = live
        self.loop = None
        self.ws_clients: set[WebSocket] = set()
        # All frames pushed so far (live mode only), replayed as the catch-up
        # message to a client connecting after the run started. Mirrors
        # scene.states, which LiveViewer.push_state also appends to via
        # scene.add_state -- kept as a separate list here rather than reaching
        # into the scene so SimViewServer doesn't need a reference to it.
        self.frame_buffer: list[dict] = []
        if sim_path is None:
            self.sim_paths: list[Path] | None = None
        elif isinstance(sim_path, (str, Path)):
            self.sim_paths = [Path(sim_path)]
        else:
            self.sim_paths = [Path(p) for p in sim_path]
        # Single-file convenience accessor, used by _load_data when nothing is preloaded.
        self.sim_path = self.sim_paths[0] if self.sim_paths else None
        self._preloaded_data = data
        self.model_data = None

        @asynccontextmanager
        async def lifespan(app: FastAPI):
            # Captured here (rather than e.g. in run()) because this runs on
            # the server thread's event loop once uvicorn starts serving --
            # LiveViewer needs this exact loop object to bridge push_state
            # (caller's thread) into broadcast_frame via
            # asyncio.run_coroutine_threadsafe.
            self.loop = asyncio.get_running_loop()
            yield

        self.app = FastAPI(lifespan=lifespan)
        # Instance-scoped state (self.model_data, self.model_bytes, ...) lives on this
        # object rather than in module-level globals, so multiple SimViewServer
        # instances (e.g. in tests) never share or clobber each other's data. It is
        # also mirrored onto app.state for the FastAPI-idiomatic access pattern.
        self.app.state.server = self

        # Local viewer only: restrict cross-origin requests to localhost/127.0.0.1.
        self.app.add_middleware(
            CORSMiddleware,
            allow_origin_regex=_ALLOWED_ORIGIN_REGEX,
            allow_credentials=True,
            allow_methods=["GET", "POST"],
            allow_headers=["*"],
        )

        # Mount static files and setup templates. StaticFiles adds ETag/Last-Modified
        # headers so unchanged assets (vendored libs, textures) are served from cache;
        # our own JS is cache-busted via the ?v= query param in index.html. The
        # Cache-Control subclass additionally marks vendored libs as immutable.
        self.app.mount(
            "/static", CacheControlStaticFiles(directory=STATIC), name="static"
        )
        self.templates = Jinja2Templates(directory=TEMPLATES)

        # Pre-serialized, gzipped payloads for HTTP serving. The parsed dicts are
        # discarded after compression to avoid holding the simulation twice in memory.
        self.model_bytes = None
        self.states_bytes = None
        self._load_data()

        self.setup_routes()

    def _names_sidecar_path(self) -> Path | None:
        """Where custom batch names get persisted, so they survive a server restart.

        Keyed by a hash of all input paths (not just the first) so that merging the
        same file with different partners doesn't collide on one sidecar."""
        if not self.sim_paths:
            return None
        key = hashlib.sha1(
            "|".join(str(p.resolve()) for p in self.sim_paths).encode()
        ).hexdigest()[:10]
        return (
            self.sim_paths[0].parent
            / f".{self.sim_paths[0].stem}.{key}.batchnames.json"
        )

    def _source_fingerprint(self) -> dict[str, float] | None:
        """mtime of every source file, keyed by resolved path.

        Saved alongside custom batch names so a later load can tell whether the
        source file(s) were regenerated since the names were saved - if so, the
        names no longer necessarily describe the current batches and must not be
        applied."""
        if not self.sim_paths:
            return None
        return {str(p.resolve()): p.stat().st_mtime for p in self.sim_paths}

    def _load_data(self):
        if self._preloaded_data is not None:
            data = self._preloaded_data
            self._preloaded_data = None  # allow it to be garbage-collected
        else:
            # __init__ requires sim_path and/or data; if we get here,
            # _preloaded_data was None, so sim_path (hence self.sim_path) was
            # provided and is guaranteed non-None.
            assert self.sim_path is not None
            logger.info("Loading simulation data from %s...", self.sim_path)
            raw = read_maybe_gzipped_bytes(self.sim_path)
            data = orjson.loads(raw) if orjson else json.loads(raw)

        model_data = data.get("model")
        states_data = data.get("states")

        names_path = self._names_sidecar_path()
        if model_data is not None and names_path and names_path.is_file():
            try:
                payload = json.loads(names_path.read_text())
                # Legacy sidecars are a bare list with no fingerprint; trust them as
                # before. Current sidecars wrap the names with the mtimes of the
                # source file(s) at save time, so a stale sidecar left over from a
                # since-regenerated file can be detected and ignored.
                if isinstance(payload, list):
                    saved_names, saved_fingerprint = payload, None
                else:
                    saved_names = payload.get("names")
                    saved_fingerprint = payload.get("source_mtime")

                sim_batches = int(model_data.get("simBatches", 1))
                stale = (
                    saved_fingerprint is not None
                    and saved_fingerprint != self._source_fingerprint()
                )
                if stale:
                    logger.info(
                        "Ignoring batch names in %s: source file(s) changed since "
                        "they were saved.",
                        names_path,
                    )
                elif isinstance(saved_names, list) and len(saved_names) == sim_batches:
                    model_data["batchNames"] = saved_names
            except (OSError, ValueError, json.JSONDecodeError) as e:
                logger.warning("Failed to load batch names from %s: %s", names_path, e)

        self.blobs = []
        # Random per-load token folded into every blob URL so it's safe to cache
        # them forever: a later server restart serving a different scene on the
        # same port gets a different token, so it can never collide with a
        # stale cached response for blob id N from a previous load.
        self._blob_token = secrets.token_hex(4)

        def extract_blobs(obj):
            if isinstance(obj, dict):
                for k, v in obj.items():
                    if isinstance(v, str) and v.startswith("__b64__"):
                        blob_id = len(self.blobs)
                        self.blobs.append(base64.b64decode(v[7:]))
                        obj[k] = f"/blob/{self._blob_token}/{blob_id}"
                    else:
                        extract_blobs(v)
            elif isinstance(obj, list):
                for i, v in enumerate(obj):
                    if isinstance(v, str) and v.startswith("__b64__"):
                        blob_id = len(self.blobs)
                        self.blobs.append(base64.b64decode(v[7:]))
                        obj[i] = f"/blob/{self._blob_token}/{blob_id}"
                    else:
                        extract_blobs(v)

        self.model_data = model_data

        if self.model_data is not None:
            extract_blobs(self.model_data)

        def register_blob(raw: bytes) -> str:
            blob_id = len(self.blobs)
            self.blobs.append(raw)
            return f"/blob/{self._blob_token}/{blob_id}"

        # Repack the per-frame states array into whole-trajectory columnar
        # blobs (wire format v4, see README "Binary state fields") so the
        # viewer parses one lightweight JSON index plus raw binary instead of
        # thousands of tiny per-frame objects/base64 strings. Falls back to
        # serving `states_data` exactly as before if it isn't strictly
        # consistent across frames (see _columnarize_states).
        if isinstance(states_data, list) and states_data:
            columnar = _columnarize_states(states_data, model_data, register_blob)
            if columnar is not None:
                states_data = columnar
        # Discard the raw per-frame states list now that everything needed
        # from it (columnar or not) has been extracted -- it can be large
        # (the dominant memory user for a long simulation).
        del data

        # Pre-serialize and pre-compress once so HTTP endpoints never do work per request.
        # compresslevel=1 is fastest (still typically 5-10x smaller for JSON). model_data
        # itself is kept around (it's small, unlike states_data) so /batch-names can
        # patch and re-serialize it without re-reading the source file.
        self._dumps = orjson.dumps if orjson else (lambda o: json.dumps(o).encode())
        if model_data is not None:
            self.model_bytes = gzip.compress(self._dumps(model_data), compresslevel=1)
        if self.live:
            # Live mode: frames arrive over /ws/states instead, so /states just
            # tells the client to open the socket (see loadData in SimView.js).
            self.states_bytes = gzip.compress(
                self._dumps({"live": True}), compresslevel=1
            )
        elif states_data is not None:
            self.states_bytes = gzip.compress(self._dumps(states_data), compresslevel=1)

        logger.info("Simulation data loaded successfully.")

    def setup_routes(self):
        @self.app.get("/")
        async def index(request: Request):
            return self.templates.TemplateResponse(
                request=request,
                name="index.html",
                context={"request": request, "t": int(time.time())},
            )

        _gzip_headers = {"Content-Encoding": "gzip"}

        @self.app.get("/model")
        async def get_model():
            logger.debug("HTTP: Client requested /model")
            if self.model_bytes is not None:
                return Response(
                    content=self.model_bytes,
                    media_type="application/json",
                    headers=_gzip_headers,
                )
            return Response(
                content=b'{"message":"Model data not available"}',
                media_type="application/json",
                status_code=404,
            )

        @self.app.get("/states")
        async def get_states():
            logger.debug("HTTP: Client requested /states")
            if self.states_bytes is not None:
                return Response(
                    content=self.states_bytes,
                    media_type="application/json",
                    headers=_gzip_headers,
                )
            return Response(
                content=b'{"message":"States data not available"}',
                media_type="application/json",
                status_code=404,
            )

        @self.app.get("/blob/{token}/{blob_id}")
        async def get_blob(token: str, blob_id: int):
            if token != self._blob_token or not (0 <= blob_id < len(self.blobs)):
                return Response(status_code=404)
            return Response(
                content=self.blobs[blob_id],
                media_type="application/octet-stream",
                headers={"Cache-Control": "public, max-age=31536000, immutable"},
            )

        @self.app.post("/batch-names")
        async def set_batch_names(body: BatchNamesRequest):
            if self.model_data is None:
                return Response(
                    content=b'{"message":"Model data not available"}',
                    media_type="application/json",
                    status_code=404,
                )
            names = body.names
            sim_batches = int(self.model_data.get("simBatches", 1))
            if len(names) != sim_batches:
                return Response(
                    content=b'{"message":"Expected {\\"names\\": [str, ...]} matching simBatches"}',
                    media_type="application/json",
                    status_code=400,
                )

            self.model_data["batchNames"] = names
            self.model_bytes = gzip.compress(
                self._dumps(self.model_data), compresslevel=1
            )

            names_path = self._names_sidecar_path()
            if names_path:
                try:
                    payload = {
                        "names": names,
                        "source_mtime": self._source_fingerprint(),
                    }
                    names_path.write_text(json.dumps(payload))
                except OSError as e:
                    logger.warning(
                        "Failed to persist batch names to %s: %s", names_path, e
                    )

            return {"ok": True}

        if self.live:
            # Only registered in live mode: LiveViewer.push_state broadcasts
            # each new frame to every connected socket (see broadcast_frame).
            # Frames buffered before this client connected are replayed as one
            # catch-up message first, so a viewer opened mid-run still sees
            # the whole timeline so far.
            @self.app.websocket("/ws/states")
            async def ws_states(websocket: WebSocket):
                await websocket.accept()
                self.ws_clients.add(websocket)
                try:
                    if self.frame_buffer:
                        await websocket.send_text(
                            json.dumps({"states": list(self.frame_buffer)})
                        )
                    while True:
                        # This endpoint is push-only; block here until the
                        # client disconnects (or the connection otherwise dies)
                        # so the `finally` below can discard it.
                        await websocket.receive_text()
                except WebSocketDisconnect:
                    pass
                finally:
                    self.ws_clients.discard(websocket)

    async def broadcast_frame(self, frame: dict) -> None:
        """Send one newly-pushed frame to every connected /ws/states client.

        Must run on self.loop (the server thread's event loop) -- LiveViewer
        schedules this via asyncio.run_coroutine_threadsafe rather than
        calling it directly from the caller's thread. A dead/broken socket is
        dropped rather than allowed to raise, since one slow/gone client must
        never break the broadcast (or the caller's push_state) for the rest.
        """
        if not self.ws_clients:
            return
        message = json.dumps({"states": [frame]})
        dead = []
        for client in self.ws_clients:
            try:
                await client.send_text(message)
            except Exception:
                dead.append(client)
        for client in dead:
            self.ws_clients.discard(client)

    def run(
        self,
        debug: bool = False,
        host: str = "127.0.0.1",
        port: int = 5420,
        open_browser: bool = False,
    ):
        logger.info("SimView server running on http://%s:%s", host, port)
        if open_browser:
            import threading
            import webbrowser

            # uvicorn.run() below blocks until the server stops, so the browser is
            # opened from a background timer instead of a startup hook (FastAPI's
            # on_event/lifespan hooks are more ceremony than this one-shot needs).
            # The short delay gives uvicorn a head start on binding the socket.
            bind_host = "127.0.0.1" if host in ("0.0.0.0", "::") else host
            threading.Timer(
                0.5, webbrowser.open, args=(f"http://{bind_host}:{port}",)
            ).start()

        # uvloop/httptools are faster than the stdlib fallbacks but aren't available
        # everywhere (uvloop doesn't support Windows). Use them opportunistically and
        # fall back to uvicorn's "auto" detection rather than crashing at startup.
        try:
            import uvloop  # noqa: F401

            loop = "uvloop"
        except ImportError:
            loop = "auto"
        try:
            import httptools  # noqa: F401

            http = "httptools"
        except ImportError:
            http = "auto"
        uvicorn.run(
            self.app,
            host=host,
            port=port,
            log_level="debug" if debug else "info",
            loop=loop,
            http=http,
        )

    @staticmethod
    def start(
        sim_path: str | Path | Sequence[str | Path],
        host: str = "127.0.0.1",
        preferred_port: int = 5420,
        open_browser: bool = False,
    ):
        paths = (
            [Path(sim_path)]
            if isinstance(sim_path, (str, Path))
            else [Path(p) for p in sim_path]
        )
        for p in paths:
            if not p.is_file():
                raise FileNotFoundError(f"Simulation file '{p}' does not exist.")

        if len(paths) > 1:
            from simview.merge import merge_simulation_files

            server = SimViewServer(data=merge_simulation_files(paths), sim_path=paths)
        else:
            server = SimViewServer(sim_path=paths[0])
        port = find_free_port(host, preferred_port)
        if port != preferred_port:
            logger.warning(
                "Preferred port %s is not available. Using port %s instead.",
                preferred_port,
                port,
            )
        server.run(host=host, port=port, open_browser=open_browser)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Run the SimView server.")
    parser.add_argument(
        "--sim_path", type=str, required=True, help="Path to the simulation JSON file."
    )
    args = parser.parse_args()
    SimViewServer.start(args.sim_path)
