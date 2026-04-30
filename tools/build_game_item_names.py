import argparse
import csv
import struct
from pathlib import Path

import UnityPy

from build_card_name_map import CARD_ID_RE, get_script_path_id, is_name_key, load_table_entries
from build_gem_text_map import GEM_ID_RE, referenced_localized_name


def raw_localized_name(value):
    return str(value or "").strip()


def find_referenced_name(raw, localized_names):
    matches = []
    for offset in range(0, len(raw) - 8):
        table_id = struct.unpack_from("<Q", raw, offset)[0]
        if table_id in localized_names:
            matches.append((offset, localized_names[table_id]))
    return matches[0][1] if matches else ""


def load_script_ids(global_env):
    script_names = {}
    for obj in global_env.objects:
        if obj.type.name != "MonoScript":
            continue
        tree = obj.read_typetree()
        script_names[obj.path_id] = tree.get("m_ClassName", "")

    return {
        "card": {path_id for path_id, name in script_names.items() if name in {"CardConfig", "FccConfig"}},
        "gem": {path_id for path_id, name in script_names.items() if name == "GemConfig"},
    }


def build_rows(game_data):
    localization_dir = game_data / "StreamingAssets" / "aa" / "StandaloneWindows64"
    global_assets = game_data / "globalgamemanagers.assets"

    card_keys, card_localized = load_table_entries(localization_dir, "Cards Shared Data", "Cards_en")
    card_names = {
        table_id: raw_localized_name(card_localized.get(table_id, ""))
        for table_id, key in card_keys.items()
        if is_name_key(key)
    }
    card_names = {key: value for key, value in card_names.items() if value}

    gem_keys, gem_localized = load_table_entries(localization_dir, "Gems Shared Data", "Gems_en")
    gem_names = {
        table_id: raw_localized_name(gem_localized.get(table_id, ""))
        for table_id, key in gem_keys.items()
        if key.startswith("GEM_NAME_")
    }
    gem_names = {key: value for key, value in gem_names.items() if value}

    global_env = UnityPy.load(str(global_assets))
    script_ids = load_script_ids(global_env)
    config_inputs = [global_assets, game_data / "resources.assets"]
    config_inputs += sorted(game_data.glob("sharedassets*.assets"))

    rows_by_key = {}
    diagnostics = []

    for input_path in config_inputs:
        if not input_path.exists():
            continue

        env = global_env if input_path == global_assets else UnityPy.load(str(input_path))
        for obj in env.objects:
            if obj.type.name != "MonoBehaviour":
                continue

            raw = obj.get_raw_data()
            script_id = get_script_path_id(raw)
            if script_id in script_ids["card"]:
                item_kind = "card"
                ids = sorted({match.group().decode("ascii") for match in CARD_ID_RE.finditer(raw)})
                name = find_referenced_name(raw, card_names)
            elif script_id in script_ids["gem"]:
                item_kind = "gem"
                ids = sorted({match.group().decode("ascii") for match in GEM_ID_RE.finditer(raw)})
                name = referenced_localized_name(raw, gem_names)
            else:
                continue

            if not ids:
                continue

            if not name:
                diagnostics.append((input_path.name, obj.path_id, item_kind, ids))

            for item_id in ids:
                rows_by_key[(item_kind, item_id)] = {
                    "kind": item_kind,
                    "id": item_id,
                    "name": name,
                }

    return [rows_by_key[key] for key in sorted(rows_by_key)], diagnostics


def main():
    parser = argparse.ArgumentParser(description="Build a CSV of game item IDs and localized names.")
    parser.add_argument(
        "--game-data",
        default=r"C:\Program Files (x86)\Steam\steamapps\common\Vampire Crawlers\Vampire Crawlers_Data",
        help="Path to Vampire Crawlers_Data.",
    )
    parser.add_argument(
        "--output",
        default="data/game-item-names.csv",
        help="Output CSV path, relative to project root.",
    )
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[1]
    game_data = Path(args.game_data)
    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = project_root / output_path

    rows, diagnostics = build_rows(game_data)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["kind", "id", "name"], lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

    print(f"Wrote {len(rows)} game item name rows to {output_path}")
    if diagnostics:
        print(f"Items without localized name refs: {len(diagnostics)}")
        for asset_name, path_id, item_kind, ids in diagnostics[:20]:
            print(f"  {asset_name}:{path_id}: {item_kind} {', '.join(ids)}")


if __name__ == "__main__":
    main()
