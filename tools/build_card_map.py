import argparse
import json
import re
import struct
from pathlib import Path

import UnityPy


CARD_ID_RE = re.compile(rb"(?:Card_[A-Z]_[0-9]_[A-Za-z0-9]+|FCC_[A-Za-z0-9]+)")


def get_script_path_id(raw):
    if len(raw) < 28:
        return None
    return struct.unpack_from("<q", raw, 20)[0]


def get_strings(raw):
    return [
        match.group().decode("ascii", "ignore")
        for match in re.finditer(rb"[A-Za-z0-9_ ]{3,}", raw)
    ]


def iter_pptrs(raw):
    for offset in range(0, len(raw) - 12, 4):
        file_id = struct.unpack_from("<i", raw, offset)[0]
        path_id = struct.unpack_from("<q", raw, offset + 4)[0]
        yield offset, file_id, path_id


def load_manifest(manifest_path):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    sprite_paths = {}
    for item in manifest:
        if item.get("bundle") != "globalgamemanagers.assets":
            continue
        path = item.get("path") or item.get("duplicateOf")
        if path:
            sprite_paths[item["pathId"]] = path
    return sprite_paths


def main():
    parser = argparse.ArgumentParser(description="Build card ID to sprite map for Vampire Crawlers.")
    parser.add_argument(
        "--game-data",
        default=r"C:\Program Files (x86)\Steam\steamapps\common\Vampire Crawlers\Vampire Crawlers_Data",
        help="Path to Vampire Crawlers_Data.",
    )
    parser.add_argument(
        "--manifest",
        default="public/assets/art-manifest.json",
        help="Extracted art manifest path, relative to project root.",
    )
    parser.add_argument(
        "--output",
        default="public/assets/card-map.json",
        help="Output card map path, relative to project root.",
    )
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[1]
    game_data = Path(args.game_data)
    global_assets = game_data / "globalgamemanagers.assets"
    manifest_path = Path(args.manifest)
    if not manifest_path.is_absolute():
        manifest_path = project_root / manifest_path

    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = project_root / output_path

    global_env = UnityPy.load(str(global_assets))
    objects = {obj.path_id: obj for obj in global_env.objects}
    sprite_paths = load_manifest(manifest_path)

    script_names = {}
    for obj in global_env.objects:
        if obj.type.name != "MonoScript":
            continue
        tree = obj.read_typetree()
        script_names[obj.path_id] = tree.get("m_ClassName", "")

    card_config_script_ids = {
        path_id for path_id, name in script_names.items() if name in {"CardConfig", "FccConfig"}
    }
    fcc_config_script_ids = {
        path_id for path_id, name in script_names.items() if name == "FccConfig"
    }
    card_group_script_ids = {
        path_id for path_id, name in script_names.items() if name == "CardGroup"
    }

    groups = {}
    for obj in global_env.objects:
        if obj.type.name != "MonoBehaviour":
            continue

        raw = obj.get_raw_data()
        if get_script_path_id(raw) not in card_group_script_ids:
            continue

        strings = get_strings(raw)
        group_id = next((text for text in strings if text.startswith("CardGroup_")), None)
        if not group_id:
            continue

        sprite_refs = [
            path_id
            for _, file_id, path_id in iter_pptrs(raw)
            if file_id == 0
            and path_id in objects
            and objects[path_id].type.name == "Sprite"
            and path_id in sprite_paths
        ]
        if sprite_refs:
            groups[obj.path_id] = {
                "groupId": group_id,
                "spritePathId": sprite_refs[-1],
                "path": sprite_paths[sprite_refs[-1]],
            }

    card_map = {}
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
            script_path_id = get_script_path_id(raw)
            if script_path_id not in card_config_script_ids:
                continue

            card_ids = sorted({match.group().decode("ascii") for match in CARD_ID_RE.finditer(raw)})
            if not card_ids:
                continue

            group_refs = [
                path_id
                for _, _, path_id in iter_pptrs(raw)
                if path_id in groups
            ]
            if not group_refs:
                diagnostics.append(
                    {
                        "asset": input_path.name,
                        "pathId": obj.path_id,
                        "cardIds": card_ids,
                        "reason": "no group ref",
                    }
                )
                continue

            direct_sprite_refs = [
                path_id
                for _, _, path_id in iter_pptrs(raw)
                if path_id in sprite_paths
                and path_id in objects
                and objects[path_id].type.name == "Sprite"
            ]
            group = groups[group_refs[0]]
            art_path = (
                sprite_paths[direct_sprite_refs[0]]
                if script_path_id in fcc_config_script_ids and direct_sprite_refs
                else group["path"]
            )
            for card_id in card_ids:
                card_map[card_id] = art_path

    output_path.write_text(json.dumps(dict(sorted(card_map.items())), indent=2) + "\n", encoding="utf-8")

    print(f"Wrote {len(card_map)} card art mappings to {output_path}")
    print(f"Resolved {len(groups)} card groups")
    if diagnostics:
        print(f"Unmapped card configs: {len(diagnostics)}")
        for item in diagnostics[:20]:
            print(f"  {item['pathId']}: {', '.join(item['cardIds'])} ({item['reason']})")


if __name__ == "__main__":
    main()
