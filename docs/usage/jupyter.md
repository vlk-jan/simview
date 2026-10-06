# Jupyter / Non-blocking Viewing

`scene.show()` starts a viewer on a background thread and returns immediately,
instead of blocking like `SimViewLauncher`/`SimViewServer.run`. This is handy in a
notebook: evaluating the returned handle as a cell's result embeds the viewer inline
via an iframe.

```python
handle = scene.show()  # non-blocking; scene itself is left untouched
handle  # in Jupyter, displays the viewer inline (uses _repr_html_)

# ... do other work, or just let the cell above stay interactive ...

handle.stop()  # or: `with scene.show() as handle: ...` to stop automatically
```

Pass `view` (a view-link fragment, built with `simview.view_hash`) and `height`
to control what the inline viewer opens with, e.g. a fixed time and no UI panels:

```python
from simview import view_hash

scene.show(view=view_hash(t=2.0, ui=False), height=400)
```

To embed a scene in any web page without a Python server, write a static bundle
with `scene.save_static("out/")`, host it, and open the viewer with
`view_hash(data="https://host/out")`.

See the [`ViewerHandle` API reference](../api/scene.md) for the full behavior.
