"""`<link rel="modulepreload">` tags for the viewer page.

The browser only discovers an ES module's imports after it has fetched and
parsed the importer, so the ~50-file module graph downloads one dependency
level at a time. Listing every module in the page head lets them all start at
once (a ~50 ms round trip each otherwise adds up level by level).
"""

import json
import re
from functools import cache
from pathlib import Path

# `import ... from "x"`, `export ... from "x"` and side-effect `import "x"`.
# Dynamic import() is skipped: those modules are lazy on purpose.
_STATIC_IMPORT = re.compile(
    r"""(?:^|[;\n])\s*(?:import|export)\b[^;'"]*?(?:\bfrom\s*)?["']([^"']+)["']\s*;?""",
)
_IMPORTMAP = re.compile(r'<script type="importmap">(.*?)</script>', re.S)
PLACEHOLDER = "<!-- @modulepreload -->"


def _resolve(
    spec: str, importer: Path, root: Path, imports: dict[str, str]
) -> Path | None:
    """Filesystem path `spec` points at, or None for anything outside `root`."""
    if spec.startswith("."):
        target = importer.parent / spec
    else:
        # Bare specifier -> import map; "prefix/" entries map whole directories.
        for key, value in imports.items():
            if spec == key or (key.endswith("/") and spec.startswith(key)):
                target = root / (value + spec[len(key) :])
                break
        else:
            return None
    target = target.resolve()
    return target if target.is_file() and root in target.parents else None


def module_graph(html: str, root: Path, entry: str = "static/js/main.js") -> list[str]:
    """Page-relative URLs (`./static/...`) of every module reachable from `entry`."""
    match = _IMPORTMAP.search(html)
    imports = json.loads(match.group(1))["imports"] if match else {}
    imports = {k: v.removeprefix("./") for k, v in imports.items()}
    root = root.resolve()
    seen: dict[Path, None] = {}
    todo = [(root / entry).resolve()]
    while todo:
        path = todo.pop()
        if path in seen:
            continue
        seen[path] = None
        for spec in _STATIC_IMPORT.findall(path.read_text(encoding="utf-8")):
            dep = _resolve(spec, path, root, imports)
            if dep is not None:
                todo.append(dep)
    return ["./" + p.relative_to(root).as_posix() for p in seen]


@cache
def render_index(index_path: str, root: str) -> str:
    """index.html with its modulepreload placeholder filled in."""
    html = Path(index_path).read_text(encoding="utf-8")
    links = "\n    ".join(
        f'<link rel="modulepreload" href="{url}" />'
        for url in module_graph(html, Path(root))
    )
    return html.replace(PLACEHOLDER, links)
