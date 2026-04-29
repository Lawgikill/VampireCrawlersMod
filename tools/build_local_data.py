import argparse
import sys
from pathlib import Path

import build_card_cost_map
import build_card_map
import build_card_name_map
import build_card_text_map
import build_text_meta
import build_gem_map
import build_gem_text_map
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
    parser.add_argument("--card-text", type=Path, required=True)
    parser.add_argument("--text-meta", type=Path, required=True)
    parser.add_argument("--gem-map", type=Path, required=True)
    parser.add_argument("--gem-text", type=Path, required=True)
    parser.add_argument("--min-size", default="16")
    args = parser.parse_args()

    game_data = args.game_dir / "Vampire Crawlers_Data"
    display_overrides = Path(__file__).resolve().parents[1] / "data" / "display-overrides.csv"

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
    run_step(
        "build_card_text_map",
        build_card_text_map.main,
        [
            "--game-data",
            str(game_data),
            "--output",
            str(args.card_text),
            "--text-overrides",
            str(display_overrides),
        ],
    )
    run_step(
        "build_gem_map",
        build_gem_map.main,
        [
            "--game-data",
            str(game_data),
            "--manifest",
            str(args.manifest),
            "--output",
            str(args.gem_map),
        ],
    )
    run_step(
        "build_gem_text_map",
        build_gem_text_map.main,
        [
            "--game-data",
            str(game_data),
            "--output",
            str(args.gem_text),
            "--text-overrides",
            str(display_overrides),
        ],
    )
    run_step(
        "build_text_meta",
        build_text_meta.main,
        [
            "--output",
            str(args.text_meta),
            "--display-overrides",
            str(display_overrides),
        ],
    )


if __name__ == "__main__":
    main()
