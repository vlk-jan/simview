import argparse
import shutil
import sys
from pathlib import Path

from simview import CACHE_DIR
from simview.server import SimViewServer


def clear_cache():
    for cache_dir in (Path("/tmp") / CACHE_DIR, Path.home() / ".cache" / CACHE_DIR):
        if cache_dir.exists():
            print(f"Removing {cache_dir}")
            shutil.rmtree(cache_dir, ignore_errors=True)

    print("Cache cleared.")


def main():
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

    # We parse known args to allow for potential future flags for the server passed through
    args, unknown = parser.parse_known_args()

    if not args.inputs:
        parser.print_help()
        sys.exit(1)

    if args.inputs == ["clear"]:
        clear_cache()
        return

    paths = [Path(p) for p in args.inputs]
    for path in paths:
        if not (path.exists() and path.is_file()):
            print(f"Error: File '{path}' not found or is not a file.")
            sys.exit(1)

    SimViewServer.start(sim_path=paths if len(paths) > 1 else paths[0])


if __name__ == "__main__":
    main()
