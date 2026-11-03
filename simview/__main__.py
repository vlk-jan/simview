"""The `simview` command-line interface."""

import argparse
import gzip
import json
import logging
import math
import os
import shutil
import sys
from pathlib import Path

from simview import CACHE_DIR, __version__, remote
from simview.server import SimViewServer
from simview.utils import (
    dumps_json,
    human_bytes,
    load_scene,
    load_scene_model,
    resolve_batch,
)

logger = logging.getLogger("simview.cli")

_logging_configured = False

# Subcommands with their own scoped flags. "view" also works bare
# (`simview <file>...`) -- see main()'s routing.
_SUBCOMMANDS = (
    "view",
    "info",
    "diff",
    "terrain",
    "sample",
    "render",
    "clear",
    "static-viewer",
)


def _configure_logging() -> None:
    """CLI entry point default: INFO-level, message-only output on stderr.

    Kept minimal (no timestamps/level names) since this is user-facing CLI
    chatter, not application log output meant for parsing. Idempotent, so
    calling `main()` more than once in the same process (e.g. across tests)
    doesn't stack up duplicate handlers.
    """
    global _logging_configured
    if _logging_configured:
        return
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(message)s"))
    root = logging.getLogger("simview")
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    _logging_configured = True


def _package_version() -> str:
    """The installed simview version, with a sensible fallback for editable
    checkouts run without an installed distribution (e.g. `python -m simview`
    from a source tree that was never `pip install -e`'d)."""
    if __version__ == "0.0.0.dev0":
        return "unknown (not installed)"
    return __version__


def _dir_size(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def clear_cache():
    """Remove simview's on-disk cache of scene files fetched from remote hosts
    (see `simview.remote`), including the default location when
    $XDG_CACHE_HOME points elsewhere."""
    freed = 0
    for cache_dir in dict.fromkeys(
        (remote.cache_dir(), Path.home() / ".cache" / CACHE_DIR)
    ):
        if not cache_dir.is_dir():
            continue
        freed += _dir_size(cache_dir)
        logger.info("Removing %s", cache_dir)
        shutil.rmtree(cache_dir, ignore_errors=True)

    if freed:
        logger.info("Freed %s.", human_bytes(freed))

    logger.info("Cache cleared.")


def export_static_viewer(directory: Path) -> None:
    """Copy the viewer page (`index.html` + `static/`) into `directory`, so a
    site can host it next to `SimulationScene.save_static` bundles and open
    `index.html#data=<bundle url>` with no SimView server. The page's asset
    URLs are page-relative already, so the files are copied verbatim."""
    from importlib.resources import files

    package = files("simview")
    directory.mkdir(parents=True, exist_ok=True)
    from simview.preload import render_index

    index = package / "templates" / "index.html"
    static = package / "static"
    (directory / "index.html").write_text(
        render_index(str(index), str(package)), encoding="utf-8"
    )
    shutil.copytree(str(static), directory / "static", dirs_exist_ok=True)
    logger.info("Static viewer written to %s", directory)


def _print_result(result: dict, args: argparse.Namespace, text_fn, csv_fn=None):
    """Print `result` as CSV, JSON (`--json`; single-line with `--full`, whose
    grids would otherwise print one number per line) or text."""
    if csv_fn is not None and getattr(args, "csv", False):
        print(csv_fn(result), end="")
    elif args.json:
        # sample is all short vectors: indented, each number gets its own line.
        compact = getattr(args, "full", False) or args.command == "sample"
        print(dumps_json(result, indent=None if compact else 2))
    else:
        print(text_fn(result))


def run_info(path: Path, as_json: bool, full: bool = False) -> None:
    """Print a structural summary of the scene JSON at `path` to stdout."""
    from simview.info import format_text, summarize_scene

    try:
        summary = summarize_scene(path, full=full)
    except (json.JSONDecodeError, ValueError, KeyError) as e:
        logger.error("Error: Could not parse '%s' as a scene file: %s", path, e)
        sys.exit(1)

    if as_json:
        print(dumps_json(summary, indent=2))
    else:
        print(format_text(summary))


def run_terrain(path: Path, args: argparse.Namespace) -> None:
    """Print terrain value(s) at a point, over an area, or along a body's
    trajectory, from the scene JSON at `path`, to stdout. With `--batches
    A B`, compares two batches instead of querying a single one (for
    `--along-body`, both batches' terrains are sampled along batch A's
    trajectory -- see `query_along_body_diff`)."""
    from simview import terrain as terrain_mod

    if args.area is not None and len(args.area) not in (0, 4):
        logger.error(
            "Error: --area requires 0 values (whole terrain extent) or 4 values "
            "(xmin xmax ymin ymax); got %d.",
            len(args.area),
        )
        sys.exit(1)

    diff_mode = args.batches is not None

    try:
        mask = terrain_mod.parse_mask(args.mask) if args.mask else None
        if args.along_body is not None:
            model_data, states_data = load_scene(path)
            batch = resolve_batch(model_data, args.batch, "--batch")
            if diff_mode:
                batch_a, batch_b = _resolve_batch_pair(model_data, args.batches)
                result = terrain_mod.query_along_body_diff(
                    model_data,
                    states_data,
                    args.along_body,
                    batch_a,
                    batch_b,
                    args.layer,
                    args.every,
                    args.t0,
                    args.t1,
                )
                text_fn = terrain_mod.format_along_diff_text
                csv_fn = terrain_mod.format_along_diff_csv
            else:
                result = terrain_mod.query_along_body(
                    model_data,
                    states_data,
                    args.along_body,
                    args.layer,
                    batch,
                    args.every,
                    args.t0,
                    args.t1,
                )
                text_fn = terrain_mod.format_along_text
                csv_fn = terrain_mod.format_along_csv
        else:
            model_data = load_scene_model(path)
            batch = resolve_batch(model_data, args.batch, "--batch")
            if diff_mode:
                batch_a, batch_b = _resolve_batch_pair(model_data, args.batches)
                if args.point is not None:
                    result = terrain_mod.query_point_diff(
                        model_data,
                        args.point[0],
                        args.point[1],
                        batch_a,
                        batch_b,
                        args.layer,
                    )
                    text_fn = terrain_mod.format_point_diff_text
                    csv_fn = terrain_mod.format_point_diff_csv
                else:
                    bounds = tuple(args.area) if args.area else None
                    result = terrain_mod.query_area_diff(
                        model_data,
                        bounds,
                        batch_a,
                        batch_b,
                        args.layer,
                        args.stride,
                        mask,
                    )
                    if not args.full:
                        result = terrain_mod.area_summary(result)
                    text_fn = terrain_mod.format_area_diff_text
                    csv_fn = terrain_mod.format_area_diff_csv
            elif args.point is not None:
                result = terrain_mod.query_point(
                    model_data, args.point[0], args.point[1], args.layer, batch
                )
                text_fn = terrain_mod.format_point_text
                csv_fn = terrain_mod.format_point_csv
            else:
                bounds = tuple(args.area) if args.area else None
                result = terrain_mod.query_area(
                    model_data, bounds, args.layer, batch, args.stride, mask
                )
                if not args.full:
                    result = terrain_mod.area_summary(result)
                text_fn = terrain_mod.format_area_text
                csv_fn = terrain_mod.format_area_csv
    except (json.JSONDecodeError, ValueError, KeyError) as e:
        logger.error("Error: %s", e)
        sys.exit(1)

    _print_result(result, args, text_fn, csv_fn)


def _resolve_batch_pair(model_data: dict, specs) -> tuple[int, int]:
    return (
        resolve_batch(model_data, specs[0], "--batches A"),
        resolve_batch(model_data, specs[1], "--batches B"),
    )


def _load_inputs(specs: list[str], args: argparse.Namespace) -> tuple[dict, list]:
    """`(model, states)` for one scene file, or for several files (or one
    with a '#<batches>' selection) merged into one scene, as `view` does."""
    from simview.merge import merge_simulation_files, split_batch_spec

    split = [split_batch_spec(spec) for spec in specs]
    paths = [_resolve_input(spec, args) for spec, _ in split]
    selections = [selector for _, selector in split]
    if len(paths) == 1 and selections[0] is None:
        return load_scene(paths[0])
    merged = merge_simulation_files(paths, selections)
    return merged["model"], merged["states"]


def run_sample(args: argparse.Namespace) -> None:
    """Print poses/velocities/contacts/scalars at chosen frames or times."""
    from simview import sample as sample_mod

    try:
        model_data, states_data = _load_inputs(args.files, args)
        batches = (
            [resolve_batch(model_data, b, "--batch") for b in args.batch]
            if args.batch
            else None
        )
        frames = sample_mod.select_frames(states_data, args.frames, args.t, args.count)
        result = sample_mod.sample_states(
            model_data, states_data, frames, body=args.body, batches=batches
        )
    except (json.JSONDecodeError, ValueError, KeyError) as e:
        logger.error("Error: %s", e)
        sys.exit(1)

    _print_result(
        result, args, sample_mod.format_sample_text, sample_mod.format_sample_csv
    )


def run_diff(args: argparse.Namespace) -> None:
    """Print a trajectory divergence report between two batches of the scene
    JSON at `path`, to stdout. With `--fail-on-exceed`, additionally exits
    with a non-zero code once printing is done: 0 = within thresholds, 1 =
    usage/parse error, 2 = a threshold was exceeded (see `--fail-on-exceed`'s
    help text)."""
    from simview import diff as diff_mod

    if (
        args.fail_on_exceed
        and args.pos_threshold is None
        and args.rot_threshold_deg is None
    ):
        logger.error(
            "Error: --fail-on-exceed requires --pos-threshold and/or "
            "--rot-threshold-deg."
        )
        sys.exit(1)

    try:
        model_data, states_data = _load_inputs(args.files, args)
        if args.batches is not None:
            batch_a, batch_b = _resolve_batch_pair(model_data, args.batches)
        elif int(model_data.get("simBatches") or 1) == 2:
            batch_a, batch_b = 0, 1
        else:
            raise ValueError(
                "--batches A B is required unless the scene (or the merged "
                "inputs) has exactly 2 batches, e.g. 'simview diff scene.json "
                "--batches GT 1' or 'simview diff gt.json#0 pred.json#0'"
            )
        result = diff_mod.compute_trajectory_diff(
            model_data,
            states_data,
            batch_a,
            batch_b,
            body=args.body,
            every=args.every,
            pos_threshold=args.pos_threshold,
            rot_threshold_deg=args.rot_threshold_deg,
            per_axis=args.per_axis,
            t0=args.t0,
            t1=args.t1,
            align_first_frame=args.align_first_frame,
        )
    except (json.JSONDecodeError, ValueError, KeyError) as e:
        logger.error("Error: %s", e)
        sys.exit(1)

    _print_result(result, args, diff_mod.format_diff_text, diff_mod.format_diff_csv)

    if args.fail_on_exceed:
        exceeded = any(
            body["summary"]["first_frame_exceeding_pos_threshold"] is not None
            or body["summary"]["first_frame_exceeding_rot_threshold"] is not None
            for body in result["bodies"].values()
        )
        if exceeded:
            sys.exit(2)


# Mirrors BatchManager.js: batches sit on a ceil(sqrt(B))-wide grid of
# terrain-sized cells, 0.5 m apart, batch 0 at the origin cell.
_BATCH_SPACING = 0.5


def _top_camera(model: dict, batch: int | None):
    """`(cam, tgt)` looking straight down on one batch's terrain cell, or on
    the whole batch grid when `batch` is None."""
    terrain = model.get("terrain") or {}
    bounds, dims = terrain.get("bounds"), terrain.get("dimensions")
    if not bounds or not dims:
        raise ValueError("--camera top needs a scene with terrain")
    batches = int(model.get("simBatches") or 1)
    side = math.ceil(math.sqrt(batches))
    step_x = dims["sizeX"] + _BATCH_SPACING
    step_y = dims["sizeY"] + _BATCH_SPACING
    if batch is None:
        cols, rows = min(side, batches), math.ceil(batches / side)
        off_x, off_y = (cols - 1) * step_x / 2, (rows - 1) * step_y / 2
        size_x, size_y = cols * step_x, rows * step_y
    else:
        off_x, off_y = (batch % side) * step_x, (batch // side) * step_y
        size_x, size_y = dims["sizeX"], dims["sizeY"]
    cx = (bounds["minX"] + bounds["maxX"]) / 2 + off_x
    cy = (bounds["minY"] + bounds["maxY"]) / 2 + off_y
    extent = max(size_x, size_y)
    # Nudged off-vertical: z is up, and an exactly vertical view leaves the
    # orbit camera's up vector undefined.
    cam = (cx, cy - 1e-3 * extent, (bounds.get("maxZ") or 0.0) + 1.5 * extent)
    return cam, (cx, cy, bounds.get("minZ") or 0.0)


def _render_view_hash(path: Path, args: argparse.Namespace, t: float | None) -> str:
    """View hash for one `simview render` shot from its shortcut flags."""
    from simview.view import view_hash

    cam = tgt = None
    batch = None
    if args.camera == "top" or args.batch is not None:
        model = load_scene_model(path)
        if args.batch is not None:
            batch = resolve_batch(model, args.batch, "--batch")
        if args.camera == "top":
            cam, tgt = _top_camera(model, batch)
    return view_hash(
        t=t,
        cam=cam,
        tgt=tgt,
        batch=batch,
        track=args.track,
        terrain_color_mode=args.terrain_color,
        ui=False if args.hide_ui else None,
    )


def _shot_path(output: Path, t: float, count: int) -> Path:
    if count == 1:
        return output
    return output.with_name(f"{output.stem}_t{t}{output.suffix}")


def run_render(path: Path, args: argparse.Namespace) -> None:
    """Headlessly render PNG screenshot(s) of the scene JSON at `path`, for
    generating figures from a display-less environment (e.g. a SLURM job)."""
    from simview.render import render_screenshots

    if args.output is None:
        logger.error(
            "Error: 'simview render' requires --output, e.g. 'simview render "
            "scene.json --output frame.png'."
        )
        sys.exit(1)
    shortcuts = (
        args.t,
        args.camera,
        args.track,
        args.batch,
        args.terrain_color,
        args.hide_ui or None,
    )
    if args.view is not None and any(v is not None for v in shortcuts):
        logger.error(
            "Error: --view can't be combined with --t/--camera/--track/--batch/"
            "--terrain-color/--hide-ui; put everything in the hash, or use the "
            "flags only."
        )
        sys.exit(1)

    output = Path(args.output)
    try:
        if args.view is not None:
            shots = [(args.view, output)]
        elif any(v is not None for v in shortcuts):
            times = list(dict.fromkeys(args.t or [None]))
            shots = [
                (_render_view_hash(path, args, t), _shot_path(output, t, len(times)))
                for t in times
            ]
        else:
            shots = [(None, output)]
        render_screenshots(
            path,
            shots,
            host=args.host,
            port=args.port,
            width=args.width,
            height=args.height,
        )
    except ImportError as e:
        logger.error("Error: %s", e)
        sys.exit(1)
    except ValueError as e:
        logger.error("Error: %s", e)
        sys.exit(1)
    except (RuntimeError, TimeoutError) as e:
        logger.error("Error: 'simview render' failed: %s", e)
        sys.exit(1)


def save_merged(
    paths: list[Path],
    out_path: Path,
    selections: list[str | None] | None = None,
) -> None:
    """Merge `paths` (must be >= 2, or 1 with a batch selection) and write the
    result to `out_path`, gzipped if it ends in .gz, without starting the
    server."""
    selected = selections is not None and any(s is not None for s in selections)
    if len(paths) < 2 and not selected:
        logger.error("Error: --save-merged requires at least 2 input files to merge.")
        sys.exit(1)

    from simview.columnar import columnarize_states, inline_blob
    from simview.merge import merge_simulation_files

    merged = merge_simulation_files(paths, selections)
    # Pack the merged states the same way SimulationScene.save does: merge
    # decodes every blob to plain lists, so dumping it directly would write
    # the fat legacy per-frame layout. Falls back silently when numpy is
    # unavailable or the states are too irregular (columnarize_states
    # returns None).
    columnar_states = columnarize_states(merged["states"], merged["model"], inline_blob)
    if columnar_states is not None:
        merged["states"] = columnar_states
    payload = dumps_json(merged).encode("utf-8")
    if out_path.suffix == ".gz":
        payload = gzip.compress(payload, compresslevel=1)
    try:
        # Like SimulationScene.save: create missing parent directories.
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(payload)
    except OSError as e:
        logger.error("Error: cannot write merged scene to '%s': %s", out_path, e)
        sys.exit(1)
    logger.info("Merged scene written to %s", out_path)


def _resolve_input(spec: str, args: argparse.Namespace) -> Path:
    """Resolve one CLI input to a local file, first fetching it over SSH if it
    is an scp-style 'host:path' spec (see `simview.remote`). Everything
    downstream only ever sees an ordinary local path."""
    try:
        path = remote.resolve_input(spec, refresh=args.refresh, offline=args.offline)
    except remote.RemoteError as e:
        logger.error("Error: %s", e)
        sys.exit(1)
    if not (path.exists() and path.is_file()):
        logger.error("Error: File '%s' not found or is not a file.", path)
        sys.exit(1)
    return path


class _ArgParser(argparse.ArgumentParser):
    """argparse's default error() exits with code 2; this CLI reserves 2 for
    `diff --fail-on-exceed` (a threshold was exceeded), so every other
    usage/parse error -- ours or argparse's own -- must exit 1 instead."""

    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(1, f"{self.prog}: error: {message}\n")


def _add_remote_flags(sp: argparse.ArgumentParser) -> None:
    sp.add_argument(
        "--refresh",
        action="store_true",
        help=(
            "Re-fetch remote 'host:path' inputs even if the cached copy still "
            "matches the remote file."
        ),
    )
    sp.add_argument(
        "--offline",
        action="store_true",
        help=(
            "Use the cached copy of remote 'host:path' inputs without contacting "
            "the host at all; fails if nothing is cached for them yet."
        ),
    )


def _add_json_csv_flags(sp: argparse.ArgumentParser) -> None:
    fmt = sp.add_mutually_exclusive_group()
    fmt.add_argument(
        "--json",
        action="store_true",
        help="Print machine-readable JSON instead of text.",
    )
    fmt.add_argument("--csv", action="store_true", help="Print CSV instead of text.")


def _add_host_port_flags(sp: argparse.ArgumentParser) -> None:
    sp.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help=(
            "Host/interface for the server to bind to (default: 127.0.0.1). "
            "Note: the server has no authentication, so binding to a "
            "non-loopback address exposes the scene data to everyone who can "
            "reach it."
        ),
    )
    sp.add_argument(
        "--port",
        type=int,
        default=5420,
        help=(
            "Port for the server to use (default: 5420). If it's already taken, "
            "the next free port is used instead."
        ),
    )


def _add_files_arg(sp: argparse.ArgumentParser) -> None:
    sp.add_argument(
        "files",
        nargs="+",
        metavar="file",
        help=(
            "Scene file(s) or 'host:path' specs. Several files -- or one with a "
            "'#<batches>' selection, e.g. 'gt.json#0 pred.json#GT' -- are "
            "merged into one scene first, as 'simview view' does."
        ),
    )


def _add_time_window_flags(sp: argparse.ArgumentParser, prefix: str) -> None:
    sp.add_argument(
        "--t0",
        type=float,
        default=None,
        metavar="SECONDS",
        help=f"{prefix} use states at or after this time.",
    )
    sp.add_argument(
        "--t1",
        type=float,
        default=None,
        metavar="SECONDS",
        help=f"{prefix} use states at or before this time.",
    )


def _add_file_arg(sp: argparse.ArgumentParser) -> None:
    sp.add_argument(
        "file",
        help=(
            "Path to a simulation JSON file, or an scp-style 'host:path' spec "
            "(e.g. 'rci:~/results/scene.json'), fetched over ssh into a local "
            "cache and re-fetched only when the remote file changes."
        ),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = _ArgParser(
        description=(
            "SimView CLI. Run with one or more simulation JSON file paths to "
            "launch the viewer -- multiple files are merged into one scene, "
            "each file's batches appended as extra batches (e.g. a real-world "
            "recording plus a simulated rerun). Append '#<batches>' to a file "
            "to merge only some of its batches (e.g. 'run.json#1', "
            "'run.json#0,2-3', 'run.json#-1' or 'run.json#<batch name>'), so a "
            "ground truth shared by several files isn't merged once per file. "
            "Any input may instead be an scp-style 'host:path' spec, fetched "
            "over ssh -- compressed on the wire -- into a local cache."
        )
    )
    parser.add_argument(
        "--version",
        action="store_true",
        help="Print the installed simview version and exit.",
    )
    sub = parser.add_subparsers(dest="command")

    view = sub.add_parser(
        "view", help="Launch the viewer on one or more scene files (the default)."
    )
    view.add_argument(
        "inputs",
        nargs="*",
        help="Path(s) to simulation JSON file(s) to visualize.",
    )
    _add_host_port_flags(view)
    view.add_argument(
        "--no-browser",
        action="store_true",
        help="Don't automatically open a browser tab once the server starts.",
    )
    view.add_argument(
        "--save-merged",
        type=str,
        default=None,
        metavar="PATH",
        help=(
            "Merge the given input files and write the result to PATH instead of "
            "launching the viewer. Requires at least 2 input files, or 1 with a "
            "'#<batches>' selection. Gzips the output if PATH ends in .gz."
        ),
    )
    _add_remote_flags(view)

    info = sub.add_parser("info", help="Print a structural summary of a scene file.")
    _add_file_arg(info)
    info.add_argument(
        "--json",
        action="store_true",
        help="Print machine-readable JSON instead of text.",
    )
    info.add_argument(
        "--full",
        action="store_true",
        help="Don't cap lists (bodies, static objects, missing frames) at 20 entries.",
    )
    _add_remote_flags(info)

    terrain = sub.add_parser(
        "terrain",
        help="Query terrain values at a point, over an area, or along a body's trajectory.",
    )
    _add_file_arg(terrain)
    mode = terrain.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--point",
        nargs=2,
        type=float,
        metavar=("X", "Y"),
        help="Query terrain value(s) at a single (x, y) point (bilinear-interpolated).",
    )
    mode.add_argument(
        "--area",
        nargs="*",
        type=float,
        metavar="BOUND",
        help=(
            "Query terrain values over a rectangular area: pass no values for the "
            "whole terrain extent, or exactly 4 values 'XMIN XMAX YMIN YMAX' for a "
            "sub-box."
        ),
    )
    mode.add_argument(
        "--along-body",
        type=str,
        default=None,
        metavar="BODY",
        help=(
            "Sample terrain value(s) bilinear-interpolated at BODY's (x, y) "
            "position in every sampled state (e.g. friction/stiffness under a "
            "robot's driven path). BODY is matched the same way as 'simview diff' "
            "--body (full label, or any single name inside a rigidly-grouped "
            "body). With --batches A B, samples both batches' terrains along "
            "batch A's trajectory instead and reports the delta per layer."
        ),
    )
    terrain.add_argument(
        "--layer",
        default="all",
        help=(
            "Which terrain layer to query: 'height', 'all' (default: all "
            "present), or the name of any arbitrary property the terrain was "
            "authored with (e.g. 'friction', 'stiffness', or a custom name)."
        ),
    )
    terrain.add_argument(
        "--batch",
        default="0",
        help="Batch to query: an index (negative counts from the end) or a batch "
        "name (default: 0).",
    )
    terrain.add_argument(
        "--stride",
        type=int,
        default=1,
        help="With --area, subsample every Nth grid point in both directions (default: 1).",
    )
    terrain.add_argument(
        "--batches",
        nargs=2,
        metavar=("A", "B"),
        help=(
            "Two batches (indices or names) to compare. Switches into cross-batch diff mode "
            "(value_a/value_b/delta per layer) instead of a single-batch query, "
            "and takes precedence over --batch if both are given. For "
            "--along-body, both batches' terrains are sampled along batch A's "
            "trajectory."
        ),
    )
    terrain.add_argument(
        "--every",
        type=int,
        default=1,
        help="With --along-body, sample every Nth frame (default: 1).",
    )
    _add_time_window_flags(terrain, "With --along-body, only")
    terrain.add_argument(
        "--mask",
        default=None,
        metavar="EXPR",
        help=(
            "With --area, restrict the statistics to cells passing 'LAYER OP "
            "VALUE' (OP: > >= < <= == !=), e.g. 'known>0.5'. Evaluated on "
            "--batch, or on batch A with --batches."
        ),
    )
    terrain.add_argument(
        "--full",
        action="store_true",
        help=(
            "With --area, also print every grid cell (and x/y coordinates). "
            "Default: only the sampled extent and per-layer statistics."
        ),
    )
    _add_json_csv_flags(terrain)
    _add_remote_flags(terrain)

    diff = sub.add_parser("diff", help="Compare two batches' trajectories.")
    _add_files_arg(diff)
    diff.add_argument(
        "--batches",
        nargs=2,
        metavar=("A", "B"),
        help=(
            "Two batches (indices or names) to compare. Optional when the scene "
            "-- or the merged inputs -- has exactly 2 batches."
        ),
    )
    diff.add_argument(
        "--body",
        type=str,
        default=None,
        metavar="NAME",
        help=(
            "Restrict the trajectory diff to one body (matched by its full "
            "label, e.g. 'wheel_fl+wheel_fr', or by any single name inside a "
            "rigidly-grouped body). Default: diff every body present in states, "
            "plus any rigidly-attached body resolvable from them. Poses are "
            "compared in world space (parent chains resolved), matching the "
            "viewer's Error Metrics panel."
        ),
    )
    diff.add_argument(
        "--every",
        type=int,
        default=1,
        help="Sample every Nth frame (default: 1).",
    )
    diff.add_argument(
        "--pos-threshold",
        type=float,
        default=None,
        metavar="METERS",
        help="Report the first sampled frame whose position error exceeds this many meters.",
    )
    diff.add_argument(
        "--rot-threshold-deg",
        type=float,
        default=None,
        metavar="DEGREES",
        help=(
            "Report the first sampled frame whose orientation error exceeds "
            "this many degrees."
        ),
    )
    diff.add_argument(
        "--per-axis",
        action="store_true",
        help=(
            "Also report signed per-axis (err_x/err_y/err_z = batch_a - batch_b) "
            "position error, matching the browser Error Metrics panel's per-axis "
            "toggle."
        ),
    )
    diff.add_argument(
        "--fail-on-exceed",
        action="store_true",
        help=(
            "Exit with code 2 (after printing the normal output) if any diffed "
            "body's trajectory exceeds --pos-threshold or --rot-threshold-deg; "
            "requires at least one of them. Exit codes: 0 = within thresholds, "
            "1 = usage/parse error, 2 = threshold exceeded -- lets scripts/CI "
            "tell divergence apart from a broken invocation."
        ),
    )
    _add_time_window_flags(diff, "Only")
    diff.add_argument(
        "--align-first-frame",
        action="store_true",
        help=(
            "Express each batch's trajectory relative to its own pose at the "
            "first compared frame (R0^-1 (p - p0), R0^-1 R), so a constant "
            "start offset isn't counted as error."
        ),
    )
    _add_json_csv_flags(diff)
    _add_remote_flags(diff)

    sample = sub.add_parser(
        "sample",
        help="Print body poses, velocities, contacts and scalars at chosen frames.",
    )
    _add_files_arg(sample)
    sample.add_argument(
        "--frames",
        default=None,
        metavar="SPEC",
        help="A frame index ('-1') or Python slice ('0:2000:100', '::50').",
    )
    sample.add_argument(
        "--t",
        type=float,
        action="append",
        default=None,
        metavar="SECONDS",
        help="Sample the frame nearest this time; repeatable.",
    )
    sample.add_argument(
        "--count",
        type=int,
        default=11,
        help=(
            "Without --frames/--t, sample this many evenly spaced frames, first "
            "and last included (default: 11)."
        ),
    )
    sample.add_argument(
        "--body",
        default=None,
        metavar="NAME",
        help="Only this body (matched like 'simview diff --body'). Default: all.",
    )
    sample.add_argument(
        "--batch",
        action="append",
        default=None,
        metavar="BATCH",
        help="Only this batch (index or name); repeatable. Default: all.",
    )
    _add_json_csv_flags(sample)
    _add_remote_flags(sample)

    render = sub.add_parser(
        "render", help="Headlessly save a PNG screenshot (needs the 'render' extra)."
    )
    _add_file_arg(render)
    render.add_argument(
        "--output",
        type=str,
        default=None,
        metavar="PATH",
        help="PNG file path to save the screenshot to. Required.",
    )
    _add_host_port_flags(render)
    render.add_argument(
        "--view",
        type=str,
        default=None,
        metavar="HASH",
        help=(
            "A shareable view-link hash (from the viewer's 'Copy view link' "
            "button, with or without the leading '#') to set the "
            "camera/playback/terrain state before capturing. Default: the "
            "viewer's startup state."
        ),
    )
    render.add_argument(
        "--t",
        type=float,
        action="append",
        default=None,
        metavar="SECONDS",
        help=(
            "Playback time to capture; repeatable -- several times are captured "
            "in one browser session, saved as <output stem>_t<T>.png."
        ),
    )
    render.add_argument(
        "--camera",
        choices=["top"],
        default=None,
        help="Camera preset: 'top' looks straight down on the whole terrain.",
    )
    render.add_argument(
        "--track",
        default=None,
        metavar="BODY",
        help="Have the camera follow this body.",
    )
    render.add_argument(
        "--batch",
        default=None,
        help="Focus this batch (index or name).",
    )
    render.add_argument(
        "--terrain-color",
        default=None,
        metavar="MODE",
        help="Color the terrain by 'height' or a property name (e.g. 'friction').",
    )
    render.add_argument(
        "--hide-ui",
        action="store_true",
        help="Hide every panel, leaving only the 3D view.",
    )
    render.add_argument(
        "--width",
        type=int,
        default=1280,
        help="Screenshot width in pixels (default: 1280).",
    )
    render.add_argument(
        "--height",
        type=int,
        default=720,
        help="Screenshot height in pixels (default: 720).",
    )
    _add_remote_flags(render)

    sub.add_parser("clear", help="Remove simview's on-disk cache.")

    static_viewer = sub.add_parser(
        "static-viewer",
        help=(
            "Copy the viewer page (index.html + static/) to DIR, to host it "
            "as plain files next to save_static() bundles (open with #data=)."
        ),
    )
    static_viewer.add_argument("directory", type=Path, metavar="DIR")

    return parser


def main():
    _configure_logging()
    argv = sys.argv[1:]

    # Checked before parsing so --version works alongside any other
    # arguments, without tripping their validation.
    if "--version" in argv:
        print(_package_version())
        return

    parser = build_parser()

    if not argv:
        parser.print_help()
        sys.exit(1)

    # The bare `simview <file>...` view form has no keyword, so anything that
    # isn't a known subcommand (or -h/--help, which the top-level parser
    # should still handle itself) is routed to "view".
    if argv[0] not in _SUBCOMMANDS and argv[0] not in ("-h", "--help"):
        argv = ["view", *argv]

    args = parser.parse_args(argv)

    # Remote specs are an input-side convenience only; writing back over ssh is
    # deliberately out of scope, so catch it here rather than at open() time.
    for flag, value in (
        ("--output", getattr(args, "output", None)),
        ("--save-merged", getattr(args, "save_merged", None)),
    ):
        if value is not None and remote.is_remote_spec(value):
            logger.error(
                "Error: %s must be a local path, but '%s' looks like a remote "
                "'host:path' spec; remote specs are only supported for inputs.",
                flag,
                value,
            )
            sys.exit(1)

    if args.command == "clear":
        clear_cache()
        return
    if args.command == "static-viewer":
        export_static_viewer(args.directory)
        return

    single_file_commands = {
        "info": lambda path, args: run_info(path, as_json=args.json, full=args.full),
        "terrain": run_terrain,
        "render": run_render,
    }
    if args.command == "diff":
        run_diff(args)
        return
    if args.command == "sample":
        run_sample(args)
        return
    if args.command in single_file_commands:
        single_file_commands[args.command](_resolve_input(args.file, args), args)
        return

    # view mode: launch the viewer (or --save-merged) over one or more inputs.
    if not args.inputs:
        parser.print_help()
        sys.exit(1)

    # Split "scene.json#1,3" into the file and the batches to take from it
    # before resolving the file, so a remote spec can carry a selection too.
    from simview.merge import split_batch_spec

    try:
        split_inputs = [split_batch_spec(spec) for spec in args.inputs]
    except ValueError as e:
        logger.error("Error: %s", e)
        sys.exit(1)
    paths = [_resolve_input(spec, args) for spec, _ in split_inputs]
    selections: list[str | None] = [selector for _, selector in split_inputs]

    try:
        if args.save_merged:
            save_merged(paths, Path(args.save_merged), selections)
            return

        SimViewServer.start(
            sim_path=paths if len(paths) > 1 else paths[0],
            host=args.host,
            preferred_port=args.port,
            open_browser=not args.no_browser,
            batch_selections=selections,
        )
    except ValueError as e:
        # A bad batch selection ("scene.json#9" on a 2-batch file) is user
        # error, not a crash: report it like any other bad argument.
        logger.error("Error: %s", e)
        sys.exit(1)


def cli() -> None:
    """Console-script entry point: `main()`, quiet when stdout is closed early
    (e.g. `simview terrain ... | head`)."""
    try:
        try:
            main()
        finally:
            # Also on sys.exit (e.g. diff --fail-on-exceed), so a closed pipe
            # surfaces here rather than in the interpreter's exit-time flush.
            sys.stdout.flush()
    except BrokenPipeError:
        # Point stdout at devnull so the interpreter's own exit-time flush
        # doesn't raise a second time.
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        sys.exit(1)


if __name__ == "__main__":
    cli()
