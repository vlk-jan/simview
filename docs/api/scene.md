# Scenes & Viewer Handles

`simview.scene` is the main authoring API: `SimulationScene` builds a model
incrementally (terrain, bodies, static objects) and accumulates states, then
saves/loads JSON or launches a viewer. `ViewerHandle` is the non-blocking handle
returned by `SimulationScene.show()`.

::: simview.scene
