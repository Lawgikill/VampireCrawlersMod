import argparse
import json
import re
import struct
from pathlib import Path

import UnityPy


CARD_ID_RE = re.compile(rb"(?:Card_[A-Z]_(?:[0-9]_[A-Za-z0-9]+|[A-Za-z0-9]+)|FCC_[A-Za-z0-9]+)")


def align(value, boundary):
    return (value + boundary - 1) // boundary * boundary


def get_script_path_id(raw):
    if len(raw) < 28:
        return None
    return struct.unpack_from("<q", raw, 20)[0]


def get_tail_start(raw):
    name_length = struct.unpack_from("<I", raw, 28)[0]
    odin_length_offset = align(32 + name_length, 4) + 4
    odin_length = struct.unpack_from("<I", raw, odin_length_offset)[0]
    return align(odin_length_offset + 4 + odin_length, 4)


def iter_pptrs(raw):
    for offset in range(0, len(raw) - 12, 4):
        file_id = struct.unpack_from("<i", raw, offset)[0]
        path_id = struct.unpack_from("<q", raw, offset + 4)[0]
        yield offset, file_id, path_id


def read_primary_card_id(raw):
    match = CARD_ID_RE.search(raw)
    return match.group().decode("ascii") if match else ""


def main():
    parser = argparse.ArgumentParser(description="Build card ID to mana cost map for Vampire Crawlers.")
    parser.add_argument(
        "--game-data",
        default=r"C:\Program Files (x86)\Steam\steamapps\common\Vampire Crawlers\Vampire Crawlers_Data",
        help="Path to Vampire Crawlers_Data.",
    )
    parser.add_argument(
        "--output",
        default="public/assets/card-costs.json",
        help="Output card cost map path, relative to project root.",
    )
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[1]
    game_data = Path(args.game_data)
    global_assets = game_data / "globalgamemanagers.assets"

    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = project_root / output_path

    global_env = UnityPy.load(str(global_assets))

    script_names = {}
    for obj in global_env.objects:
        if obj.type.name != "MonoScript":
            continue
        tree = obj.read_typetree()
        script_names[obj.path_id] = tree.get("m_ClassName", "")

    card_config_script_ids = {
        path_id for path_id, name in script_names.items() if name == "CardConfig"
    }
    card_group_script_ids = {
        path_id for path_id, name in script_names.items() if name == "CardGroup"
    }

    global_card_group_path_ids = set()
    for obj in global_env.objects:
        if obj.type.name != "MonoBehaviour":
            continue
        raw = obj.get_raw_data()
        if get_script_path_id(raw) in card_group_script_ids:
            global_card_group_path_ids.add(obj.path_id)

    card_costs = {}
    diagnostics = []
    config_inputs = [global_assets]
    config_inputs += [game_data / "resources.assets"]
    config_inputs += sorted(game_data.glob("sharedassets*.assets"))

    for input_path in config_inputs:
        if not input_path.exists():
            continue

        env = global_env if input_path == global_assets else UnityPy.load(str(input_path))
        local_card_group_path_ids = set()
        for obj in env.objects:
            if obj.type.name != "MonoBehaviour":
                continue
            raw = obj.get_raw_data()
            if get_script_path_id(raw) in card_group_script_ids:
                local_card_group_path_ids.add(obj.path_id)

        for obj in env.objects:
            if obj.type.name != "MonoBehaviour":
                continue

            raw = obj.get_raw_data()
            script_path_id = get_script_path_id(raw)
            if script_path_id not in card_config_script_ids:
                continue

            tail = raw[get_tail_start(raw):]
            card_id = read_primary_card_id(tail)
            if not card_id:
                continue

            group_refs = [
                offset
                for offset, file_id, path_id in iter_pptrs(tail)
                if (
                    (file_id == 0 and path_id in local_card_group_path_ids)
                    or path_id in global_card_group_path_ids
                )
            ]
            if not group_refs:
                diagnostics.append(
                    {
                        "asset": input_path.name,
                        "pathId": obj.path_id,
                        "cardId": card_id,
                        "reason": "no group ref",
                    }
                )
                continue

            # CardConfig serializes cardType, then cardGroup, then mana fields:
            # _manaCostStyle, manaCost, _manaCosts.
            mana_offset = group_refs[0] + 12
            if mana_offset + 12 > len(tail):
                diagnostics.append(
                    {
                        "asset": input_path.name,
                        "pathId": obj.path_id,
                        "cardId": card_id,
                        "reason": "short mana data",
                    }
                )
                continue

            mana_style = struct.unpack_from("<i", tail, mana_offset)[0]
            single_cost = struct.unpack_from("<i", tail, mana_offset + 4)[0]
            cost_count = struct.unpack_from("<i", tail, mana_offset + 8)[0]
            costs = []
            if 0 <= cost_count < 32 and mana_offset + 12 + (cost_count * 4) <= len(tail):
                costs = [
                    struct.unpack_from("<i", tail, mana_offset + 12 + (index * 4))[0]
                    for index in range(cost_count)
                ]

            if mana_style == 0:
                cost = single_cost
            elif mana_style == 1 and costs:
                cost = costs[0]
            else:
                diagnostics.append(
                    {
                        "asset": input_path.name,
                        "pathId": obj.path_id,
                        "cardId": card_id,
                        "reason": f"unsupported mana style {mana_style}",
                    }
                )
                continue

            card_costs[card_id] = cost

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(dict(sorted(card_costs.items())), indent=2) + "\n", encoding="utf-8")

    print(f"Wrote {len(card_costs)} card cost mappings to {output_path}")
    if diagnostics:
        print(f"Unmapped card costs: {len(diagnostics)}")
        for item in diagnostics[:20]:
            print(f"  {item['asset']}:{item['pathId']}: {item['cardId']} ({item['reason']})")


if __name__ == "__main__":
    main()
