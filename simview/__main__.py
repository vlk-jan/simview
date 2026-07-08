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
        "input",
        nargs="?",
        help="Path to simulation JSON file to visualize, or 'clear' to clear cache.",
    )

    # We parse known args to allow for potential future flags for the server passed through
    args, unknown = parser.parse_known_args()

    if not args.input:
        parser.print_help()
        sys.exit(1)

    if args.input == "clear":
        clear_cache()
    else:
        path = Path(args.input)
        if path.exists() and path.is_file():
            SimViewServer.start(sim_path=path)
        else:
            print(f"Error: File '{path}' not found or is not a file.")
            sys.exit(1)


if __name__ == "__main__":
    main()
