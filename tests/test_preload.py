from pathlib import Path

from simview.preload import PLACEHOLDER, module_graph, render_index
from simview.server import INDEX_HTML, STATIC

ROOT = Path(STATIC).parent


def test_module_graph_reaches_every_viewer_module():
    graph = set(module_graph(Path(INDEX_HTML).read_text(encoding="utf-8"), ROOT))
    assert "./static/js/main.js" in graph
    assert "./static/lib/three-0.174.0/three.core.js" in graph  # via the import map
    on_disk = {
        "./" + p.relative_to(ROOT).as_posix()
        for p in (ROOT / "static" / "js").rglob("*.js")
    }
    # A module the preload walk misses just loads late, but one that's on disk
    # and unreachable is probably an import form the walk can't read.
    assert on_disk <= graph


def test_render_index_fills_the_placeholder():
    html = render_index(INDEX_HTML, str(ROOT))
    assert PLACEHOLDER not in html
    assert '<link rel="modulepreload" href="./static/js/SimView.js" />' in html
