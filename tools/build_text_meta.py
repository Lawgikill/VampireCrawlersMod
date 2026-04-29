import argparse
from pathlib import Path

from display_overrides import write_text_metadata


def main():
    parser = argparse.ArgumentParser(description="Build frontend display metadata from the editable display CSV.")
    parser.add_argument(
        "--text-overrides",
        dest="display_overrides",
        default="data/display-overrides.csv",
        help="CSV file containing display metadata, relative to project root.",
    )
    parser.add_argument(
        "--display-overrides",
        dest="display_overrides",
        help="CSV file containing display metadata, relative to project root.",
    )
    parser.add_argument(
        "--output",
        default="public/assets/text-meta.json",
        help="Output display metadata path, relative to project root.",
    )
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[1]
    write_text_metadata(project_root, args.output, args.display_overrides)
    print(f"Wrote display metadata to {project_root / args.output}")


if __name__ == "__main__":
    main()
