import argparse
import json
import re
import struct
from pathlib import Path

import UnityPy


CARD_ID_RE = re.compile(rb"(?:Card_[A-Z]_(?:[0-9]_[A-Za-z0-9]+|[A-Za-z0-9]+)|FCC_[A-Za-z0-9]+)")


def get_script_path_id(raw):
    if len(raw) < 28:
        return None
    return struct.unpack_from("<q", raw, 20)[0]


def load_table_entries(bundle_path, shared_name, localized_name):
    shared_entries = {}
    localized_entries = {}
    shared_bundle = bundle_path / "localization-assets-shared_assets_all.bundle"
    english_bundle = bundle_path / "localization-string-tables-english(en)_assets_all.bundle"

    for obj in UnityPy.load(str(shared_bundle)).objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except Exception:
            continue
        if tree.get("m_Name") == shared_name:
            shared_entries = {item["m_Id"]: item["m_Key"] for item in tree.get("m_Entries", [])}
            break

    for obj in UnityPy.load(str(english_bundle)).objects:
        if obj.type.name != "MonoBehaviour":
            continue
        try:
            tree = obj.read_typetree()
        except Exception:
            continue
        if tree.get("m_Name") == localized_name:
            localized_entries = {
                item["m_Id"]: item["m_Localized"]
                for item in tree.get("m_TableData", [])
            }
            break

    return shared_entries, localized_entries


def is_name_key(key):
    upper_key = key.upper()
    return all(part not in upper_key for part in ("DESC", "DESCRIPTION", "_L0", "_L1", "_L2", "_L3"))


def clean_localized_name(value):
    if not value or value.startswith("{"):
        return ""
    return value.replace("\n", " ").strip()


def find_name(raw, localized_names):
    matches = []
    for offset in range(0, len(raw) - 8):
        table_id = struct.unpack_from("<Q", raw, offset)[0]
        if table_id in localized_names:
            matches.append((offset, localized_names[table_id]))
    return matches[0][1] if matches else ""


def main():
    parser = argparse.ArgumentParser(description="Build card ID to localized display name map.")
    parser.add_argument(
        "--game-data",
        default=r"C:\Program Files (x86)\Steam\steamapps\common\Vampire Crawlers\Vampire Crawlers_Data",
        help="Path to Vampire Crawlers_Data.",
    )
    parser.add_argument(
        "--output",
        default="public/assets/card-names.json",
        help="Output card name map path, relative to project root.",
    )
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[1]
    game_data = Path(args.game_data)
    localization_dir = game_data / "StreamingAssets" / "aa" / "StandaloneWindows64"
    global_assets = game_data / "globalgamemanagers.assets"

    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = project_root / output_path

    card_keys, card_localized = load_table_entries(
        localization_dir,
        "Cards Shared Data",
        "Cards_en",
    )
    localized_names = {
        table_id: clean_localized_name(card_localized.get(table_id, ""))
        for table_id, key in card_keys.items()
        if is_name_key(key)
    }
    localized_names = {key: value for key, value in localized_names.items() if value}

    global_env = UnityPy.load(str(global_assets))
    script_names = {}
    for obj in global_env.objects:
        if obj.type.name != "MonoScript":
            continue
        tree = obj.read_typetree()
        script_names[obj.path_id] = tree.get("m_ClassName", "")

    card_config_script_ids = {
        path_id for path_id, name in script_names.items() if name in {"CardConfig", "FccConfig"}
    }

    card_names = {}
    diagnostics = []
    config_inputs = [global_assets]
    config_inputs += [game_data / "resources.assets"]
    config_inputs += sorted(game_data.glob("sharedassets*.assets"))

    for input_path in config_inputs:
        if not input_path.exists():
            continue

        env = global_env if input_path == global_assets else UnityPy.load(str(input_path))
        for obj in env.objects:
            if obj.type.name != "MonoBehaviour":
                continue

            raw = obj.get_raw_data()
            if get_script_path_id(raw) not in card_config_script_ids:
                continue

            card_ids = sorted({match.group().decode("ascii") for match in CARD_ID_RE.finditer(raw)})
            if not card_ids:
                continue

            name = find_name(raw, localized_names)
            if not name:
                diagnostics.append(
                    {
                        "asset": input_path.name,
                        "pathId": obj.path_id,
                        "cardIds": card_ids,
                        "reason": "no localized name ref",
                    }
                )
                continue

            for card_id in card_ids:
                card_names[card_id] = name

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(dict(sorted(card_names.items())), indent=2) + "\n", encoding="utf-8")

    print(f"Wrote {len(card_names)} card name mappings to {output_path}")
    if diagnostics:
        print(f"Unmapped card names: {len(diagnostics)}")
        for item in diagnostics[:20]:
            print(f"  {item['asset']}:{item['pathId']}: {', '.join(item['cardIds'])} ({item['reason']})")


if __name__ == "__main__":
    main()
