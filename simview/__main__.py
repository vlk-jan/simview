import argparse
import gzip
import json
import logging
import shutil
import sys
import tempfile
from pathlib import Path

from simview import CACHE_DIR, __version__
from simview.server import SimViewServer

logger = logging.getLogger("simview.cli")

_logging_configured = False


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


def clear_cache():
    # Legacy cache directories (kept for cleanup of older installs).
    for cache_dir in (Path("/tmp") / CACHE_DIR, Path.home() / ".cache" / CACHE_DIR):
        if cache_dir.exists():
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
    """Print terrain value(s) at a point or over an area, from the scene JSON
    at `path`, to stdout. With `--batches A B`, compares two batches instead
    of querying a single one."""
    from simview import terrain as terrain_mod

    if (args.point is None) == (args.area is None):
        logger.error(
            "Error: 'simview terrain' requires exactly one of --point or --area."
        )
        sys.exit(1)
    if args.area is not None and len(args.area) not in (0, 4):
        logger.error(
            "Error: --area requires 0 values (whole terrain extent) or 4 values "
            "(xmin xmax ymin ymax); got %d.",
            len(args.area),
        )
        sys.exit(1)
    if args.json and args.csv:
        logger.error("Error: --json and --csv are mutually exclusive.")
        sys.exit(1)

    diff_mode = args.batches is not None

    try:
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
                text = terrain_mod.format_point_diff_text(result)
                csv_text = terrain_mod.format_point_diff_csv(result)
            else:
                bounds = tuple(args.area) if args.area else None
                result = terrain_mod.query_area_diff(
                    model_data, bounds, batch_a, batch_b, args.layer, args.stride
                )
                text = terrain_mod.format_area_diff_text(result)
                csv_text = terrain_mod.format_area_diff_csv(result)
        elif args.point is not None:
            result = terrain_mod.query_point(
                model_data, args.point[0], args.point[1], args.layer, args.batch
            )
            text = terrain_mod.format_point_text(result)
            csv_text = terrain_mod.format_point_csv(result)
        else:
            bounds = tuple(args.area) if args.area else None
            result = terrain_mod.query_area(
                model_data, bounds, args.layer, args.batch, args.stride
            )
            text = terrain_mod.format_area_text(result)
            csv_text = terrain_mod.format_area_csv(result)
    except (json.JSONDecodeError, ValueError, KeyError) as e:
        logger.error("Error: %s", e)
        sys.exit(1)

    if args.csv:
        print(csv_text, end="")
    elif args.json:
        print(json.dumps(result, indent=2))
    else:
        print(text)


def run_diff(path: Path, args: argparse.Namespace) -> None:
    """Print a trajectory divergence report between two batches of the scene
    JSON at `path`, to stdout."""
    from simview import diff as diff_mod

    if args.batches is None:
        logger.error(
            "Error: 'simview diff' requires --batches A B, e.g. 'simview diff "
            "scene.json --batches 0 1'."
        )
        sys.exit(1)
    if args.json and args.csv:
        logger.error("Error: --json and --csv are mutually exclusive.")
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
        text = diff_mod.format_diff_text(result)
        csv_text = diff_mod.format_diff_csv(result)
    except (json.JSONDecodeError, ValueError, KeyError) as e:
        logger.error("Error: %s", e)
        sys.exit(1)

    if args.csv:
        print(csv_text, end="")
    elif args.json:
        print(json.dumps(result, indent=2))
    else:
        print(text)


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


def save_merged(paths: list[Path], out_path: Path) -> None:
    """Merge `paths` (must be >= 2) and write the result to `out_path`, gzipped
    if it ends in .gz, without starting the server."""
    if len(paths) < 2:
        logger.error("Error: --save-merged requires at least 2 input files to merge.")
        sys.exit(1)

    from simview.merge import merge_simulation_files

    merged = merge_simulation_files(paths)
    payload = json.dumps(merged).encode("utf-8")
    if out_path.suffix == ".gz":
        payload = gzip.compress(payload, compresslevel=1)
    out_path.write_bytes(payload)
    logger.info("Merged scene written to %s", out_path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="SimView CLI")
    parser.add_argument(
        "inputs",
        nargs="*",
        help=(
            "Path(s) to simulation JSON file(s) to visualize, 'clear' to clear "
            "cache, 'info <file>' to print a structural summary of one scene "
            "file, 'terrain <file>' to query terrain values at a point or over "
            "an area, 'diff <file>' to compare two batches' trajectories, or "
            "'render <file>' to headlessly save a PNG screenshot (needs the "
            "'render' extra). Multiple visualize-mode files are merged into "
            "one scene, each file's batches appended as extra batches (e.g. a "
            "real-world recording plus a simulated rerun)."
        ),
    )
    parser.add_argument(
        "--version",
        action="store_true",
        help="Print the installed simview version and exit.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help=(
            "With 'simview info <file>', 'simview terrain <file>', or "
            "'simview diff <file>', print machine-readable JSON instead of "
            "text."
        ),
    )
    parser.add_argument(
        "--csv",
        action="store_true",
        help=(
            "With 'simview terrain <file>' or 'simview diff <file>', print "
            "CSV instead of text. Mutually exclusive with --json."
        ),
    )
    parser.add_argument(
        "--point",
        nargs=2,
        type=float,
        metavar=("X", "Y"),
        help=(
            "With 'simview terrain <file>', query terrain value(s) at a single "
            "(x, y) point (bilinear-interpolated). Mutually exclusive with "
            "--area."
        ),
    )
    parser.add_argument(
        "--area",
        nargs="*",
        type=float,
        metavar="BOUND",
        help=(
            "With 'simview terrain <file>', query terrain values over a "
            "rectangular area: pass no values for the whole terrain extent, "
            "or exactly 4 values 'XMIN XMAX YMIN YMAX' for a sub-box. Mutually "
            "exclusive with --point."
        ),
    )
    parser.add_argument(
        "--layer",
        choices=["height", "friction", "stiffness", "all"],
        default="all",
        help=(
            "With 'simview terrain <file>', which terrain layer(s) to query "
            "(default: all present)."
        ),
    )
    parser.add_argument(
        "--batch",
        type=int,
        default=0,
        help="With 'simview terrain <file>', batch index to query (default: 0).",
    )
    parser.add_argument(
        "--stride",
        type=int,
        default=1,
        help=(
            "With 'simview terrain <file> --area', subsample every Nth grid "
            "point in both directions (default: 1)."
        ),
    )
    parser.add_argument(
        "--batches",
        nargs=2,
        type=int,
        metavar=("A", "B"),
        help=(
            "Two batch indices to compare. Required by 'simview diff <file>'. "
            "With 'simview terrain <file> --point|--area', switches into "
            "cross-batch diff mode (value_a/value_b/delta per layer) instead "
            "of a single-batch query, and takes precedence over --batch if "
            "both are given."
        ),
    )
    parser.add_argument(
        "--body",
        type=str,
        default=None,
        metavar="NAME",
        help=(
            "With 'simview diff <file>', restrict the trajectory diff to one "
            "body (matched by its full label, e.g. 'wheel_fl+wheel_fr', or by "
            "any single name inside a rigidly-grouped body). Default: diff "
            "every body present in states."
        ),
    )
    parser.add_argument(
        "--every",
        type=int,
        default=1,
        help="With 'simview diff <file>', sample every Nth frame (default: 1).",
    )
    parser.add_argument(
        "--pos-threshold",
        type=float,
        default=None,
        metavar="METERS",
        help=(
            "With 'simview diff <file>', report the first sampled frame whose "
            "position error exceeds this many meters."
        ),
    )
    parser.add_argument(
        "--rot-threshold-deg",
        type=float,
        default=None,
        metavar="DEGREES",
        help=(
            "With 'simview diff <file>', report the first sampled frame whose "
            "orientation error exceeds this many degrees."
        ),
    )
    parser.add_argument(
        "--per-axis",
        action="store_true",
        help=(
            "With 'simview diff <file>', also report signed per-axis "
            "(err_x/err_y/err_z = batch_a - batch_b) position error, matching "
            "the browser Error Metrics panel's per-axis toggle."
        ),
    )
    parser.add_argument(
        "--host",
        type=str,
        default="127.0.0.1",
        help="Host/interface for the server to bind to (default: 127.0.0.1).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=5420,
        help=(
            "Port for the server to use (default: 5420). If it's already taken, "
            "the next free port is used instead."
        ),
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Don't automatically open a browser tab once the server starts.",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        metavar="PATH",
        help="With 'simview render <file>', PNG file path to save the screenshot to.",
    )
    parser.add_argument(
        "--view",
        type=str,
        default=None,
        metavar="HASH",
        help=(
            "With 'simview render <file>', a shareable view-link hash (from "
            "the viewer's 'Copy view link' button, with or without the "
            "leading '#') to set the camera/playback/terrain state before "
            "capturing. Default: the viewer's startup state."
        ),
    )
    parser.add_argument(
        "--width",
        type=int,
        default=1280,
        help="With 'simview render <file>', screenshot width in pixels (default: 1280).",
    )
    parser.add_argument(
        "--height",
        type=int,
        default=720,
        help="With 'simview render <file>', screenshot height in pixels (default: 720).",
    )
    parser.add_argument(
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
    return parser


def main():
    _configure_logging()
    parser = build_parser()
    args = parser.parse_args()

    if args.version:
        print(_package_version())
        return

    if not args.inputs:
        parser.print_help()
        sys.exit(1)

    if args.inputs and args.inputs[0] == "info":
        info_args = args.inputs[1:]
        if len(info_args) != 1:
            logger.error(
                "Error: 'simview info' requires exactly one file argument, e.g. "
                "'simview info scene.json'."
            )
            sys.exit(1)
        info_path = Path(info_args[0])
        if not (info_path.exists() and info_path.is_file()):
            logger.error("Error: File '%s' not found or is not a file.", info_path)
            sys.exit(1)
        run_info(info_path, as_json=args.json)
        return

    if args.inputs and args.inputs[0] == "terrain":
        terrain_args = args.inputs[1:]
        if len(terrain_args) != 1:
            logger.error(
                "Error: 'simview terrain' requires exactly one file argument, "
                "e.g. 'simview terrain scene.json --point 0 0'."
            )
            sys.exit(1)
        terrain_path = Path(terrain_args[0])
        if not (terrain_path.exists() and terrain_path.is_file()):
            logger.error("Error: File '%s' not found or is not a file.", terrain_path)
            sys.exit(1)
        run_terrain(terrain_path, args)
        return

    if args.inputs and args.inputs[0] == "diff":
        diff_args = args.inputs[1:]
        if len(diff_args) != 1:
            logger.error(
                "Error: 'simview diff' requires exactly one file argument, "
                "e.g. 'simview diff scene.json --batches 0 1'."
            )
            sys.exit(1)
        diff_path = Path(diff_args[0])
        if not (diff_path.exists() and diff_path.is_file()):
            logger.error("Error: File '%s' not found or is not a file.", diff_path)
            sys.exit(1)
        run_diff(diff_path, args)
        return

    if args.inputs and args.inputs[0] == "render":
        render_args = args.inputs[1:]
        if len(render_args) != 1:
            logger.error(
                "Error: 'simview render' requires exactly one file argument, "
                "e.g. 'simview render scene.json --output frame.png'."
            )
            sys.exit(1)
        render_path = Path(render_args[0])
        if not (render_path.exists() and render_path.is_file()):
            logger.error("Error: File '%s' not found or is not a file.", render_path)
            sys.exit(1)
        run_render(render_path, args)
        return

    if args.inputs == ["clear"]:
        clear_cache()
        return

    paths = [Path(p) for p in args.inputs]
    for path in paths:
        if not (path.exists() and path.is_file()):
            logger.error("Error: File '%s' not found or is not a file.", path)
            sys.exit(1)

    if args.save_merged:
        save_merged(paths, Path(args.save_merged))
        return

    SimViewServer.start(
        sim_path=paths if len(paths) > 1 else paths[0],
        host=args.host,
        preferred_port=args.port,
        open_browser=not args.no_browser,
    )


if __name__ == "__main__":
    main()
