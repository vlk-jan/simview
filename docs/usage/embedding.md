# Embedding SimView in Another Application

SimView's viewer is a single page that can be dropped into another web app as an
`<iframe>`, pointed at data you serve yourself, stripped of its own panels, and driven
from the host page. The DRIFT dataset viewer embeds it this way.

## The embedding unit is the iframe

The page assumes it owns the whole window (the canvas and every panel are sized to
the viewport), so embed it as an `<iframe>` rather than mounting it into a `<div>`. An
iframe also scopes keyboard shortcuts to the viewer: they only fire while it has focus,
and never while the user types in a form field.

```html
<iframe src="http://127.0.0.1:5420/#v=1&t=2.5&ui=0" style="border:0;width:100%;height:600px"></iframe>
```

From Python, `scene.show(view=..., height=...)` returns a handle whose `_repr_html_`
is exactly that iframe, and `handle.url_for(view)` gives the URL for your own markup.
`simview.view_hash(...)` builds the fragment:

```python
from simview import view_hash

handle = scene.show(view=view_hash(t=2.5, cam=(8, 8, 4), tgt=(0, 0, 0), ui=False), height=480)
handle.url_for(view_hash(batch=1, terrain_color_mode="friction"))
```

## URL hash: the control surface

Everything the "Copy view link" button serialises can be set in the fragment, and
the viewer **re-applies the fragment whenever it changes** — so a host page controls
time, camera, batch and colour modes after load by assigning `iframe.src`'s hash (or
`location.hash` inside the frame), with no JavaScript access to the viewer needed.

| Key | Meaning |
| --- | --- |
| `v=1` | view-state version; required for the keys below |
| `t` | playback time in seconds (pauses playback and seeks; the only key that pauses) |
| `cam`, `tgt` | camera position and orbit target, `x,y,z` |
| `fov` | camera field of view in degrees |
| `b` | focused batch index |
| `bvm`, `tcm` | body visualization mode, terrain colour mode |
| `flags` | bitmask of the boolean toggles (`view_hash(flags={...})` builds it) |
| `pc` | point clouds visible, `0` or `1` |
| `track` | body to keep the camera on (a body name, or `None`) |
| `cmap` | terrain colour map name |
| `speed` | playback speed multiplier |

Every key is optional and an absent key leaves the viewer's current setting alone, so a
fragment can carry a whole setup between page loads (`getViewState()` → `serializeViewState`
on one page, the hash on the next) or change one thing.

Two **startup** keys are read once, at load, and don't need `v=1`:

| Key | Meaning |
| --- | --- |
| `data=<base>` | static mode: fetch `model.json`, `states.json` and `blob/<id>` from `<base>` instead of the server API (see below) |
| `ui=0` | hide every floating panel (controls, playback bar, legends, Body States, Analysis); the 3D view and keyboard shortcuts stay |
| `play=1` | start playing once the scene is loaded (applied after `t`, so `#v=1&t=30&play=1` seeks to 30 s and plays from there) |
| `hide=<panel,...>` | hide named panels, same names as `viewerDefaults.panels` (e.g. `hide=recording` drops REC, format and screenshot from the playback bar) |

## Serving the data yourself: static bundles

A scene can be written as flat files any static file server can host — no SimView
server process at all:

```python
scene.save_static("public/scenes/run42")   # model.json, states.json, blob/0, blob/1, ...
```

and loaded with `#data=/scenes/run42`. The base is an ordinary URL resolved against the
viewer page, so a page-relative `#data=../scenes/run42` works too, and the scenes can
live anywhere on the site. The viewer page itself is vendored with

```bash
simview static-viewer public/simview   # index.html + static/
```

It loads all of its assets relative to the page, so it can be served from any path of
your origin. The GitHub Pages demo is built this way (`.github/workflows/demo.yml`);
`simview.columnar.write_static_bundle` is the stdlib-only writer behind `save_static`.

Declare how the viewer should *start* at authoring time instead of patching it after
load — see `viewerDefaults` and the per-body `color`/`opacity`/`visible` fields in the
[JSON format spec](../dev/json-format.md):

```python
scene = SimulationScene(..., viewer_defaults={
    "ui": {"pointCloudsVisible": False, "terrainColorMode": "friction"},
    "folders": {"Camera Options": True, "Terrain Options": False},
    "bodyStatesOpen": False,
    "panels": {"analysis": False},
})
scene.create_body("ghost", BodyShapeType.BOX, color=(1.0, 0.7, 0.28), opacity=0.55, hx=..., hy=..., hz=...)
```

## Driving the viewer from JavaScript

A same-origin host page can reach the instance as `iframe.contentWindow.simview` (in
the page itself: `window.simview`). The supported surface:

| | |
| --- | --- |
| `simview:ready` event on `window` | the scene is loaded and rendering; `detail.simview` is the instance. In live mode it fires before the first frame arrives |
| `simview:frame` event on `window` | the displayed frame changed; `detail` is `{ index, time }` |
| `getViewState()` / `setViewState(state)` | the object behind the view link, read or applied without touching `location.hash` |
| `focusBody(name, batchIndex?)` | re-centre the orbit camera on a body, keeping the viewing angle; `false` until the body has a position |
| `animationController.play()` / `pause()` / `goToTime(t)` / `seekToIndex(i)` / `setSpeed(x)` | playback |
| `uiControls.findController(name).setValue(v)` | flip a control so the widget and the scene stay in sync (`showPointClouds`, `trackBody`, `colorMode`, ...) |
| `destroy()` | stop the render loop, close the live socket and release the renderer |

```js
const frame = document.querySelector("iframe");
frame.contentWindow.addEventListener("simview:ready", ({ detail: { simview } }) => {
    simview.focusBody("robot");
    simview.animationController.play();
});
frame.contentWindow.addEventListener("simview:frame", ({ detail }) => showImageFor(detail.index));
```

`window.__debugSimView` remains as an alias of `window.simview` for older code.

## Headless figures

`simview render --view "#v=1&t=2&cam=..."` (and `simview.render.render_screenshot`)
takes the same fragment, so a figure's view can be built with `view_hash` and rendered
through the same pipeline the interactive viewer uses.
