import asyncio
import logging
import queue
import threading
import time

import uvicorn

from simview.scene import SimulationScene
from simview.server import SimViewServer
from simview.utils import find_free_port

logger = logging.getLogger("simview.live")

# How long to poll uvicorn's Server.started flag for in __init__ before giving
# up -- binding a localhost socket and completing FastAPI startup is normally
# well under this, so a timeout here almost always means something is wrong
# (bad host, port stolen after find_free_port checked it, ...).
_START_TIMEOUT = 10.0
_START_POLL_INTERVAL = 0.02

# Frames queued for the sender thread but not yet broadcast. Bounded so a hung
# browser tab costs a fixed amount of memory instead of growing without limit;
# see LiveViewer._enqueue for what happens once it fills up.
_SEND_QUEUE_MAXSIZE = 256
# How long the sender thread waits for one broadcast to complete. Only the
# sender blocks on this -- never the caller's simulation loop.
_BROADCAST_TIMEOUT = 5.0
# How long stop() waits for the queued backlog to drain before giving up.
_SENDER_JOIN_TIMEOUT = 5.0
# Log every Nth dropped frame (plus always the first), so a persistently slow
# client produces a steady trickle of warnings rather than one per frame.
_DROP_LOG_INTERVAL = 100

# Queued by stop() to tell the sender thread to exit once it has drained
# everything pushed before it.
_STOP_SENTINEL = object()


class _ThreadedServer:
    """Runs a SimViewServer's uvicorn app on a background daemon thread.

    Shared plumbing for anything that needs a non-blocking local server
    (LiveViewer, SimulationScene.show): builds the uvicorn.Server, starts it
    on a thread, blocks until the socket is actually bound (or raises if
    startup fails/times out), and offers an idempotent `stop()`.
    """

    def __init__(
        self,
        app,
        host: str = "127.0.0.1",
        preferred_port: int = 5420,
        thread_name: str = "simview-server",
    ) -> None:
        self.host = host
        self.port = find_free_port(host, preferred_port)
        if self.port != preferred_port:
            logger.warning(
                "Preferred port %s is not available. Using port %s instead.",
                preferred_port,
                self.port,
            )

        # uvloop/httptools are faster than the stdlib fallbacks but aren't
        # available everywhere (uvloop doesn't support Windows). Use them
        # opportunistically and fall back to uvicorn's "auto" detection.
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
        # Prefer uvicorn's modern sansio websocket implementation when the
        # `websockets` package is available -- the default "auto" still selects
        # the legacy implementation, which emits DeprecationWarnings. Fall back
        # to "auto" (which degrades gracefully to wsproto/none) on a bare
        # install without `websockets`.
        try:
            import websockets  # noqa: F401

            ws = "websockets-sansio"
        except ImportError:
            ws = "auto"
        config = uvicorn.Config(
            app,
            host=host,
            port=self.port,
            log_level="info",
            loop=loop,
            http=http,
            ws=ws,
        )
        self._uvicorn_server = uvicorn.Server(config)

        self._thread = threading.Thread(
            target=self._uvicorn_server.run, name=thread_name, daemon=True
        )
        self._thread.start()

        # Block until the socket is actually bound, so a caller's very first
        # action (push_state, an HTTP request, a browser opened right after
        # construction, ...) never races server startup.
        deadline = time.monotonic() + _START_TIMEOUT
        while not self._uvicorn_server.started:
            if not self._thread.is_alive():
                raise RuntimeError("SimView server thread died during startup.")
            if time.monotonic() > deadline:
                raise TimeoutError(
                    f"SimView server did not start within {_START_TIMEOUT}s."
                )
            time.sleep(_START_POLL_INTERVAL)

    @property
    def bind_host(self) -> str:
        """Host to put in URLs -- 0.0.0.0/:: aren't dialable, so localhost
        stands in for them."""
        return "127.0.0.1" if self.host in ("0.0.0.0", "::") else self.host

    def is_alive(self) -> bool:
        return self._thread.is_alive()

    def stop(self) -> None:
        """Signal the server to exit and wait for its thread to finish.

        Idempotent -- safe to call multiple times.
        """
        if not self._thread.is_alive():
            return
        self._uvicorn_server.should_exit = True
        self._thread.join(timeout=5.0)


class LiveViewer:
    """Streams a running simulation to an already-open browser tab over
    WebSocket, instead of the usual save-then-view flow.

    ``scene`` should already have its complete model (terrain, bodies, ...) --
    states are pushed incrementally afterwards via `push_state`, using the
    same validation/encoding as `SimulationScene.add_state`. Because
    `push_state` appends to `scene.states` exactly like `add_state` would, the
    scene can still be `save()`d normally once streaming is done.

    Broadcasting happens on a dedicated sender thread fed by a bounded queue,
    so the simulation loop calling `push_state` is never blocked by a slow or
    hung browser tab -- see `_enqueue` for the backpressure policy.
    """

    def __init__(
        self,
        scene: SimulationScene,
        host: str = "127.0.0.1",
        preferred_port: int = 5420,
        open_browser: bool = False,
        queue_size: int = _SEND_QUEUE_MAXSIZE,
    ) -> None:
        if not scene.model.is_complete:
            raise ValueError(
                "Cannot start LiveViewer: the scene's model is not complete "
                "(e.g. terrain might be missing)."
            )
        self.scene = scene
        self.server = SimViewServer(
            data={"model": scene.model.to_json(), "states": []}, live=True
        )

        self._threaded = _ThreadedServer(
            self.server.app,
            host=host,
            preferred_port=preferred_port,
            thread_name="simview-live-server",
        )
        self.host = host
        self.port = self._threaded.port

        self._send_queue: queue.Queue = queue.Queue(maxsize=queue_size)
        self._stopping = threading.Event()
        self._dropped_frames = 0
        self._sender_thread = threading.Thread(
            target=self._sender_loop, name="simview-live-sender", daemon=True
        )
        self._sender_thread.start()

        logger.info(
            "SimView live server running on http://%s:%s",
            self._threaded.bind_host,
            self.port,
        )
        if open_browser:
            import webbrowser

            webbrowser.open(f"http://{self._threaded.bind_host}:{self.port}")

    def push_state(self, time, body_states, scalar_values=None) -> None:
        """Append one frame and hand it to the sender thread for broadcast.

        Runs on the caller's thread, but never blocks on the network: it
        delegates to `scene.add_state` for the same validation/encoding
        `SimulationScene` normally does (the frame also lands in
        `self.scene.states`, so `scene.save()` still works after streaming),
        records the frame for catch-up, and returns as soon as the frame is
        queued. Safe to call before any client has connected -- the frame is
        simply buffered for the next connection's catch-up message.
        """
        before = len(self.scene.states)
        self.scene.add_state(time, body_states, scalar_values=scalar_values)
        frame = self.scene.states[before]

        self.server.frame_buffer.append(frame)
        self._enqueue(frame)

    @property
    def dropped_frames(self) -> int:
        """How many frames were skipped on the wire because the viewer could
        not keep up. Purely a live-streaming statistic: dropped frames are
        still recorded in `scene.states` and in the server's catch-up buffer.
        """
        return self._dropped_frames

    def _enqueue(self, frame: dict) -> None:
        """Queue one frame for the sender thread, decimating under backpressure.

        When the queue is full (a slow or hung browser tab), the *oldest*
        pending frame is discarded to make room for the newest one, so what a
        live viewer shows keeps tracking the simulation instead of falling
        further and further behind. Nothing is lost from the recording -- the
        frame is already in `scene.states` and `server.frame_buffer`.
        """
        if self._stopping.is_set():
            # Shutting down: the stop sentinel is already (or about to be) in
            # the queue and must stay the last item, so drop rather than push.
            return
        while True:
            try:
                self._send_queue.put_nowait(frame)
                return
            except queue.Full:
                try:
                    self._send_queue.get_nowait()
                except queue.Empty:
                    # The sender drained it between our put and get; retry.
                    continue
                self._dropped_frames += 1
                if (
                    self._dropped_frames == 1
                    or self._dropped_frames % _DROP_LOG_INTERVAL == 0
                ):
                    logger.warning(
                        "SimView live viewer cannot keep up; dropped %s frame(s) "
                        "from the stream so far (the full run is still recorded).",
                        self._dropped_frames,
                    )

    def _sender_loop(self) -> None:
        """Drain the queue, broadcasting each frame on the server's event loop.

        Runs on its own daemon thread: this is where the wait for a slow client
        happens, instead of in the caller's simulation loop.
        """
        while True:
            frame = self._send_queue.get()
            if frame is _STOP_SENTINEL:
                return
            self._broadcast(frame)

    def _broadcast(self, frame: dict) -> None:
        loop = self.server.loop
        if loop is None:
            # Startup blocks until uvicorn's Server.started is set, which
            # happens after the lifespan startup hook that captures
            # server.loop -- so in practice this is unreachable, but avoid
            # killing the sender thread if it somehow occurs.
            logger.warning(
                "SimView live server loop not ready yet; frame buffered only."
            )
            return

        future = asyncio.run_coroutine_threadsafe(
            self.server.broadcast_frame(frame), loop
        )
        try:
            future.result(timeout=_BROADCAST_TIMEOUT)
        except Exception:
            logger.exception("Error broadcasting live state frame")

    def stop(self) -> None:
        """Flush queued frames, then signal the server to exit and wait for it.

        Idempotent -- safe to call multiple times (e.g. once explicitly and
        once more via __exit__).
        """
        if not self._stopping.is_set():
            self._stopping.set()
            try:
                # Bounded: producers have stopped enqueuing (self._stopping is
                # set) and the sender keeps draining, so a slot frees up unless
                # the sender thread is already gone -- in which case there is
                # nothing left to flush anyway.
                self._send_queue.put(_STOP_SENTINEL, timeout=_SENDER_JOIN_TIMEOUT)
                self._sender_thread.join(timeout=_SENDER_JOIN_TIMEOUT)
            except queue.Full:
                logger.warning("SimView live sender did not drain before shutdown.")
            if self._dropped_frames:
                logger.info(
                    "SimView live stream dropped %s frame(s) in total.",
                    self._dropped_frames,
                )
        self._threaded.stop()

    def __enter__(self) -> "LiveViewer":
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.stop()
