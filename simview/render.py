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

Runs the server via `simview.server.ViewerHandle`, the same non-blocking
background-thread server `SimulationScene.show`/`LiveViewer` use; it lives
in `server.py` (no torch/numpy), so `simview render` keeps the viewing
CLI's "just needs a scene JSON, no authoring deps" contract.
"""

import logging
from pathlib import Path

from simview.server import SimViewServer, ViewerHandle

logger = logging.getLogger("simview.cli")

_LOAD_TIMEOUT_MS = 20_000
# Extra settle time after #loading-splash detaches, for materials/camera
# controls to finish their first render pass before the screenshot is taken.
_SETTLE_DELAY_MS = 500


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
    background = ViewerHandle(
        server.app,
        host=host,
        preferred_port=port,
        thread_name="simview-render",
        log_level="warning",
    )
    try:
        fragment = f"#{view.lstrip('#')}" if view else ""
        url = f"{background.url}/{fragment}"

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
