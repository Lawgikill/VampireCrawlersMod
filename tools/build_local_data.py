import argparse
import sys
from pathlib import Path

import build_card_cost_map
import build_card_map
import build_card_name_map
import extract_art


def run_step(label, main_func, args):
    print(f"\n== {label} ==")
    previous_argv = sys.argv[:]
    try:
        sys.argv = [label, *args]
        main_func()
    finally:
        sys.argv = previous_argv


def main():
    parser = argparse.ArgumentParser(description="Build local Vampire Crawlers tracker data.")
    parser.add_argument("--game-dir", type=Path, required=True)
    parser.add_argument("--art-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--card-map", type=Path, required=True)
    parser.add_argument("--card-costs", type=Path, required=True)
    parser.add_argument("--card-names", type=Path, required=True)
    parser.add_argument("--min-size", default="16")
    args = parser.parse_args()

    game_data = args.game_dir / "Vampire Crawlers_Data"

    run_step(
        "extract_art",
        extract_art.main,
        [
            "--game-dir",
            str(args.game_dir),
            "--out",
            str(args.art_dir),
            "--manifest",
            str(args.manifest),
            "--min-size",
            str(args.min_size),
        ],
    )
    run_step(
        "build_card_map",
        build_card_map.main,
        [
            "--game-data",
            str(game_data),
            "--manifest",
            str(args.manifest),
            "--output",
            str(args.card_map),
        ],
    )
    run_step(
        "build_card_cost_map",
        build_card_cost_map.main,
        [
            "--game-data",
            str(game_data),
            "--output",
            str(args.card_costs),
        ],
    )
    run_step(
        "build_card_name_map",
        build_card_name_map.main,
        [
            "--game-data",
            str(game_data),
            "--output",
            str(args.card_names),
        ],
    )


if __name__ == "__main__":
    main()
