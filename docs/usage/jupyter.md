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

See the [`ViewerHandle` API reference](../api/scene.md) for the full behavior.
