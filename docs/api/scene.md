# Scenes & Viewer Handles

`simview.scene` is the main authoring API: `SimulationScene` builds a model
incrementally (terrain, bodies, static objects) and accumulates states, then
saves/loads JSON or launches a viewer. `SimulationScene.show()` returns a
`ViewerHandle`, the non-blocking background server.

::: simview.scene

::: simview.server.ViewerHandle
