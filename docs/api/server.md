# Server

`SimViewServer` is the FastAPI app that serves a scene's `model`/`states` (or
per-blob columnar endpoints) to the browser, and handles WebSocket live-push. Most
users won't instantiate this directly — see `SimulationScene.show()`, `LiveViewer`,
or the `simview` CLI instead.

::: simview.server.SimViewServer
