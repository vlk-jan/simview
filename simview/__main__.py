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
            "Path(s) to simulation JSON file(s) to visualize, or 'clear' to clear "
            "cache. Multiple files are merged into one scene, each file's batches "
            "appended as extra batches (e.g. a real-world recording plus a "
            "simulated rerun)."
        ),
    )
    parser.add_argument(
        "--version",
        action="store_true",
        help="Print the installed simview version and exit.",
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
