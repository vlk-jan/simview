import sys
import argparse
import shutil
from pathlib import Path
from simview import CACHE_DIR
from simview.server import SimViewServer


def clear_cache():
    tmp_dir = Path("/tmp") / CACHE_DIR
    home_dir = Path.home() / f".cache/{CACHE_DIR}"

    if tmp_dir.exists():
        print(f"Removing {tmp_dir}")
        for item in tmp_dir.iterdir():
            if item.is_dir():
                try:
                    item.rmdir()  # Might fail if not empty, but cache usually flat files or we need shutil
                except OSError:
                    shutil.rmtree(item)
            else:
                item.unlink()
        try:
            tmp_dir.rmdir()
        except OSError:
            pass

    if home_dir.exists():
        print(f"Removing {home_dir}")
        shutil.rmtree(home_dir)  # Safer for recursive delete

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

