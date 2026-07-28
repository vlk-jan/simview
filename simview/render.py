# pyright: reportMissingImports=false
# The 'render' extra (unlike 'authoring') is never assumed present for
# typechecking; the lazily imported `playwright` below is guarded by
# try/except ImportError at runtime instead (see render_screenshot).
"""Headless PNG screenshot rendering for `simview render`.

Drives a real (headless) browser against a real SimViewServer instance to
capture a screenshot of a scene -- for generating publication figures from a
SLURM/other headless environment with no display, reusing the exact
rendering pipeline (Three.js scene, shareable view-state hash) the
interactive viewer uses, rather than reimplementing a second offscreen
renderer.

Needs the `playwright` package (`pip install simview[render]`, then a
one-time `playwright install chromium` to fetch the browser binary), which
isn't part of the base install -- lazily imported by `render_screenshot` so
`import simview` and the rest of the CLI stay usable without it, matching
the `authoring` extra's lazy-import rationale in CLAUDE.md.

Deliberately doesn't reuse `simview.live`'s `_ThreadedServer`: `live.py`
imports `simview.scene`, which needs torch/numpy, but `simview render`
targets the same "just needs a scene JSON, no authoring deps" contract as
the rest of the viewing CLI (`info`/`terrain`/`diff`) -- see CLAUDE.md's
`HAS_TORCH` guidance. `_BackgroundServer` below is a small, intentionally
separate copy of the same non-blocking-uvicorn-on-a-thread pattern.
"""

import logging
import threading
import time
from pathlib import Path

import uvicorn

from simview.server import SimViewServer
from simview.utils import find_free_port

logger = logging.getLogger("simview.cli")

_START_TIMEOUT = 10.0
_START_POLL_INTERVAL = 0.02
_LOAD_TIMEOUT_MS = 20_000
# Extra settle time after #loading-splash detaches, for materials/camera
# controls to finish their first render pass before the screenshot is taken.
_SETTLE_DELAY_MS = 500


class _BackgroundServer:
    """Runs a SimViewServer's uvicorn app on a background daemon thread,
    blocking __init__ until the socket is bound. Offers an idempotent
    stop()."""

    def __init__(self, app, host: str = "127.0.0.1", preferred_port: int = 5420):
        self.host = host
        self.port = find_free_port(host, preferred_port)
        config = uvicorn.Config(app, host=host, port=self.port, log_level="warning")
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(
            target=self._server.run, name="simview-render", daemon=True
        )
        self._thread.start()

        deadline = time.monotonic() + _START_TIMEOUT
        while not self._server.started:
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

    def stop(self) -> None:
        if not self._thread.is_alive():
            return
        self._server.should_exit = True
        self._thread.join(timeout=5.0)


def render_screenshot(
    sim_path: str | Path,
    output_path: str | Path,
    host: str = "127.0.0.1",
    port: int = 5420,
    view: str | None = None,
    width: int = 1280,
    height: int = 720,
) -> None:
    """Loads `sim_path` in a headless browser and saves a PNG screenshot to
    `output_path`.

    `view` is a shareable view-link hash (with or without a leading '#' --
    see `static/js/utils/viewState.js` and the UI's "Copy view link" button),
    used to set the camera/playback/terrain-mode state before capturing.
    Without it, the screenshot is taken at the viewer's default startup
    state.

    Raises `ImportError` if the `playwright` package isn't installed,
    `FileNotFoundError` if `sim_path` doesn't exist, or `RuntimeError` if the
    page doesn't finish loading within a timeout.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:
        raise ImportError(
            "'simview render' needs the 'playwright' package: install with "
            "'pip install simview[render]' (or 'pip install playwright'), "
            "then run 'playwright install chromium' once to fetch the "
            "browser binary."
        ) from e

    output_path = Path(output_path)
    server = SimViewServer(sim_path=Path(sim_path))
    background = _BackgroundServer(server.app, host=host, preferred_port=port)
    try:
        fragment = f"#{view.lstrip('#')}" if view else ""
        url = f"http://{background.bind_host}:{background.port}/{fragment}"

        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            try:
                page = browser.new_page(viewport={"width": width, "height": height})
                page.goto(url)
                page.wait_for_selector(
                    "#loading-splash", state="detached", timeout=_LOAD_TIMEOUT_MS
                )
                page.wait_for_timeout(_SETTLE_DELAY_MS)
                output_path.parent.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(output_path))
            finally:
                browser.close()
    finally:
        background.stop()

    logger.info("Screenshot saved to %s", output_path)
