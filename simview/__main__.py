import argparse
import gzip
import json
import logging
import shutil
import sys
import tempfile
from pathlib import Path

from simview import CACHE_DIR, __version__, remote
from simview.server import SimViewServer

logger = logging.getLogger("simview.cli")

_logging_configured = False

# Subcommands with their own scoped flags. "view" (bare `simview <file>...`)
# has no keyword of its own -- see main()'s routing.
_SUBCOMMANDS = ("info", "diff", "terrain", "render", "clear")


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
    total = 0
    for entry in path.rglob("*"):
        try:
            if entry.is_file():
                total += entry.stat().st_size
        except OSError:
            pass
    return total


def clear_cache():
    """Remove simview's on-disk cache: scene files fetched from remote hosts
    (see `simview.remote`), plus locations left behind by older installs."""
    freed = 0
    seen: set[Path] = set()
    for cache_dir in (
        remote.cache_dir(),
        Path("/tmp") / CACHE_DIR,
        Path.home() / ".cache" / CACHE_DIR,
    ):
        if cache_dir in seen or not cache_dir.is_dir():
            continue
        seen.add(cache_dir)
        freed += _dir_size(cache_dir)
        logger.info("Removing %s", cache_dir)
        shutil.rmtree(cache_dir, ignore_errors=True)

    # Temp scenes written by SimViewLauncher (tempfile.mkstemp with this prefix);
    # these leak if a launched viewer is killed before cleanup runs.
    removed = 0
    for leftover in Path(tempfile.gettempdir()).glob("simview_viz_*.json"):
        try:
            leftover.unlink()
            removed += 1
        except OSError as e:
            logger.warning("Could not remove %s: %s", leftover, e)
    if removed:
        logger.info("Removed %d leftover temporary scene file(s).", removed)
    if freed:
        logger.info("Freed %s.", remote.human_bytes(freed))

    logger.info("Cache cleared.")


def run_info(path: Path, as_json: bool) -> None:
    """Print a structural summary of the scene JSON at `path` to stdout."""
    from simview.info import format_text, summarize_scene

    try:
        summary = summarize_scene(path)
    except (json.JSONDecodeError, ValueError, KeyError) as e:
        logger.error("Error: Could not parse '%s' as a scene file: %s", path, e)
        sys.exit(1)

    if as_json:
        print(json.dumps(summary, indent=2))
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
        if args.along_body is not None:
            model_data, states_data = terrain_mod.load_scene(path)
            if diff_mode:
                batch_a, batch_b = args.batches
                result = terrain_mod.query_along_body_diff(
                    model_data,
                    states_data,
                    args.along_body,
                    batch_a,
                    batch_b,
                    args.layer,
                    args.every,
                )
                text_fn = terrain_mod.format_along_diff_text
                csv_fn = terrain_mod.format_along_diff_csv
            else:
                result = terrain_mod.query_along_body(
                    model_data,
                    states_data,
                    args.along_body,
                    args.layer,
                    args.batch,
                    args.every,
                )
                text_fn = terrain_mod.format_along_text
                csv_fn = terrain_mod.format_along_csv
        else:
            model_data = terrain_mod.load_scene_model(path)
            if diff_mode:
                batch_a, batch_b = args.batches
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
                        model_data, bounds, batch_a, batch_b, args.layer, args.stride
                    )
                    text_fn = terrain_mod.format_area_diff_text
                    csv_fn = terrain_mod.format_area_diff_csv
            elif args.point is not None:
                result = terrain_mod.query_point(
                    model_data, args.point[0], args.point[1], args.layer, args.batch
                )
                text_fn = terrain_mod.format_point_text
                csv_fn = terrain_mod.format_point_csv
            else:
                bounds = tuple(args.area) if args.area else None
                result = terrain_mod.query_area(
                    model_data, bounds, args.layer, args.batch, args.stride
                )
                text_fn = terrain_mod.format_area_text
                csv_fn = terrain_mod.format_area_csv
    except (json.JSONDecodeError, ValueError, KeyError) as e:
        logger.error("Error: %s", e)
        sys.exit(1)

    if args.csv:
        print(csv_fn(result), end="")
    elif args.json:
        print(json.dumps(result, indent=2))
    else:
        print(text_fn(result))


def run_diff(path: Path, args: argparse.Namespace) -> None:
    """Print a trajectory divergence report between two batches of the scene
    JSON at `path`, to stdout. With `--fail-on-exceed`, additionally exits
    with a non-zero code once printing is done: 0 = within thresholds, 1 =
    usage/parse error, 2 = a threshold was exceeded (see `--fail-on-exceed`'s
    help text)."""
    from simview import diff as diff_mod

    if args.batches is None:
        logger.error(
            "Error: 'simview diff' requires --batches A B, e.g. 'simview diff "
            "scene.json --batches 0 1'."
        )
        sys.exit(1)
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
        model_data, states_data = diff_mod.load_scene(path)
        result = diff_mod.compute_trajectory_diff(
            model_data,
            states_data,
            args.batches[0],
            args.batches[1],
            body=args.body,
            every=args.every,
            pos_threshold=args.pos_threshold,
            rot_threshold_deg=args.rot_threshold_deg,
            per_axis=args.per_axis,
        )
    except (json.JSONDecodeError, ValueError, KeyError) as e:
        logger.error("Error: %s", e)
        sys.exit(1)

    if args.csv:
        print(diff_mod.format_diff_csv(result), end="")
    elif args.json:
        print(json.dumps(result, indent=2))
    else:
        print(diff_mod.format_diff_text(result))

    if args.fail_on_exceed:
        exceeded = any(
            body["summary"]["first_frame_exceeding_pos_threshold"] is not None
            or body["summary"]["first_frame_exceeding_rot_threshold"] is not None
            for body in result["bodies"].values()
        )
        if exceeded:
            sys.exit(2)


def run_render(path: Path, args: argparse.Namespace) -> None:
    """Headlessly render one PNG screenshot of the scene JSON at `path`, for
    generating figures from a display-less environment (e.g. a SLURM job)."""
    from simview.render import render_screenshot

    if args.output is None:
        logger.error(
            "Error: 'simview render' requires --output, e.g. 'simview render "
            "scene.json --output frame.png'."
        )
        sys.exit(1)

    try:
        render_screenshot(
            path,
            args.output,
            host=args.host,
            port=args.port,
            view=args.view,
            width=args.width,
            height=args.height,
        )
    except ImportError as e:
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

    from simview.merge import merge_simulation_files

    merged = merge_simulation_files(paths, selections)
    payload = json.dumps(merged).encode("utf-8")
    if out_path.suffix == ".gz":
        payload = gzip.compress(payload, compresslevel=1)
    out_path.write_bytes(payload)
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
    view.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Host/interface for the server to bind to (default: 127.0.0.1).",
    )
    view.add_argument(
        "--port",
        type=int,
        default=5420,
        help=(
            "Port for the server to use (default: 5420). If it's already taken, "
            "the next free port is used instead."
        ),
    )
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
            "launching the viewer. Requires at least 2 input files. Gzips the "
            "output if PATH ends in .gz."
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
        "--batch", type=int, default=0, help="Batch index to query (default: 0)."
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
        type=int,
        metavar=("A", "B"),
        help=(
            "Two batch indices to compare. Switches into cross-batch diff mode "
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
    _add_json_csv_flags(terrain)
    _add_remote_flags(terrain)

    diff = sub.add_parser("diff", help="Compare two batches' trajectories.")
    _add_file_arg(diff)
    diff.add_argument(
        "--batches",
        nargs=2,
        type=int,
        metavar=("A", "B"),
        help="Two batch indices to compare. Required.",
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
    _add_json_csv_flags(diff)
    _add_remote_flags(diff)

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
    render.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Host/interface for the server to bind to (default: 127.0.0.1).",
    )
    render.add_argument(
        "--port",
        type=int,
        default=5420,
        help=(
            "Port for the server to use (default: 5420). If it's already taken, "
            "the next free port is used instead."
        ),
    )
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

    return parser


def main():
    _configure_logging()
    argv = sys.argv[1:]

    # Checked first, and unconditionally, to match every other flag/subcommand
    # combination -- mirrors the old flat parser, where --version short-circuited
    # before any other validation ran.
    if "--version" in argv:
        print(_package_version())
        return

    parser = build_parser()

    if not argv:
        parser.print_help()
        sys.exit(1)

    # No subcommand keyword names the bare `simview <file>...` view form, so
    # anything that isn't a known subcommand (or -h/--help, which the top-level
    # parser should still handle itself) is routed to the hidden "view" one.
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

    if args.command == "info":
        path = _resolve_input(args.file, args)
        run_info(path, as_json=args.json)
        return

    if args.command == "terrain":
        path = _resolve_input(args.file, args)
        run_terrain(path, args)
        return

    if args.command == "diff":
        path = _resolve_input(args.file, args)
        run_diff(path, args)
        return

    if args.command == "render":
        path = _resolve_input(args.file, args)
        run_render(path, args)
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


if __name__ == "__main__":
    main()
