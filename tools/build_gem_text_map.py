import argparse
import json
import re
import struct
from pathlib import Path

import UnityPy

from build_card_name_map import clean_localized_name, is_name_key
from build_card_text_map import clean_text, load_table_entries
from display_overrides import load_text_overrides


GEM_ID_RE = re.compile(rb"GemConfig_[A-Za-z0-9_]+")

GEM_EFFECT_TEXT = {
    "ArmorEffect": ("Add {amount} Armor.", "_armorAmount"),
    "DrawEffect": ("Draw {amount} card.", "_drawAmount"),
    "EchoEffect": "Echo.",
    "HealEffect": ("Heal {amount} HP.", "_healAmount"),
    "MagneticEffect": "Magnetic.",
    "SprightlyEffect": "Recycle.",
}

MANA_GEM_TEXT = {
    "GemConfig_Mana_Plus1": "Increase Mana Cost.",
    "GemConfig_Mana_Plus2": "Increase Mana Cost.",
    "GemConfig_Mana_Minus1": "Reduce Mana Cost.",
    "GemConfig_Mana_Minus2": "Reduce Mana Cost.",
}

def get_script_path_id(raw):
    if len(raw) < 28:
        return None
    return struct.unpack_from("<q", raw, 20)[0]


def get_name(raw):
    if len(raw) < 32:
        return ""
    length = struct.unpack_from("<I", raw, 28)[0]
    if length > 200 or 32 + length > len(raw):
        return ""
    return raw[32:32 + length].decode("utf-8", "replace")


def iter_pptrs(raw):
    for offset in range(0, len(raw) - 12, 4):
        file_id = struct.unpack_from("<i", raw, offset)[0]
        path_id = struct.unpack_from("<q", raw, offset + 4)[0]
        yield offset, file_id, path_id


def length_prefixed_utf16_strings(raw):
    strings = []
    for offset in range(0, len(raw) - 8):
        length = struct.unpack_from("<I", raw, offset)[0]
        byte_length = length * 2
        end = offset + 4 + byte_length
        if length < 3 or length > 160 or end > len(raw):
            continue

        data = raw[offset + 4:end]
        if all(data[index + 1] == 0 and 32 <= data[index] <= 126 for index in range(0, len(data), 2)):
            strings.append((offset, data.decode("utf-16le")))
    return strings


def simple_type_name(full_type_name):
    type_name = full_type_name.split(",")[0].split(".")[-1]
    return type_name.split("+")[0]


def command_effects_from_raw(raw):
    effects = []
    for _, text in length_prefixed_utf16_strings(raw):
        if "Nosebleed.Pancake.GameCommands." not in text:
            continue
        effect_name = simple_type_name(text)
        if effect_name.endswith("Effect") and effect_name not in effects:
            effects.append(effect_name)
    return effects


def int_field_value(raw, field_name):
    needle = field_name.encode("utf-16le")
    field_offset = raw.find(needle)
    if field_offset < 4:
        return None

    length_offset = field_offset - 4
    length = struct.unpack_from("<I", raw, length_offset)[0]
    if length != len(field_name):
        return None

    value_offset = length_offset + 4 + length * 2
    if value_offset + 4 > len(raw):
        return None

    return struct.unpack_from("<i", raw, value_offset)[0]


def amount_text(value):
    return str(value) if value is not None else "XX"


def format_effect_text(raw, effect_template):
    if isinstance(effect_template, str):
        return effect_template

    template, field_name = effect_template
    value = int_field_value(raw, field_name)
    return template.format(amount=amount_text(value))


def referenced_localized_name(raw, localized_names):
    matches = []
    for offset in range(0, len(raw) - 8):
        table_id = struct.unpack_from("<Q", raw, offset)[0]
        if table_id in localized_names:
            matches.append((offset, localized_names[table_id]))
    return matches[0][1] if matches else ""


def build_card_name_lookup(config_inputs, global_env, card_config_script_ids, localized_names):
    card_names = {}
    for input_path in config_inputs:
        if not input_path.exists():
            continue
        env = global_env if input_path.name == "globalgamemanagers.assets" else UnityPy.load(str(input_path))
        for obj in env.objects:
            if obj.type.name != "MonoBehaviour":
                continue
            raw = obj.get_raw_data()
            if get_script_path_id(raw) not in card_config_script_ids:
                continue
            name = referenced_localized_name(raw, localized_names)
            if name:
                card_names[obj.path_id] = name
    return card_names


def build_gem_text(raw, gem_id, local_objects, global_objects, card_names_by_path, gem_name):
    for effect_name in command_effects_from_raw(raw):
        if effect_name == "AddCardEffect":
            for _, file_id, path_id in iter_pptrs(raw):
                if file_id != 1:
                    continue
                card_name = card_names_by_path.get(path_id)
                if card_name:
                    return f"{card_name}."
        if effect_name in GEM_EFFECT_TEXT:
            return format_effect_text(raw, GEM_EFFECT_TEXT[effect_name])

    if gem_id in MANA_GEM_TEXT:
        return MANA_GEM_TEXT[gem_id]

    return f"{gem_name}." if gem_name else ""


def main():
    parser = argparse.ArgumentParser(description="Build gem ID to short display text map.")
    parser.add_argument(
        "--game-data",
        default=r"C:\Program Files (x86)\Steam\steamapps\common\Vampire Crawlers\Vampire Crawlers_Data",
        help="Path to Vampire Crawlers_Data.",
    )
    parser.add_argument(
        "--output",
        default="public/assets/gem-text.json",
        help="Output gem text map path, relative to project root.",
    )
    parser.add_argument(
        "--text-overrides",
        default="data/display-overrides.csv",
        help="CSV file containing display overrides, relative to project root.",
    )
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[1]
    gem_text_overrides = load_text_overrides(project_root, "gem", args.text_overrides)
    game_data = Path(args.game_data)
    localization_dir = game_data / "StreamingAssets" / "aa" / "StandaloneWindows64"
    global_assets = game_data / "globalgamemanagers.assets"

    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = project_root / output_path

    gem_keys, gem_localized = load_table_entries(localization_dir, "Gems Shared Data", "Gems_en")
    localized_gem_names = {
        table_id: clean_text(gem_localized.get(table_id, ""))
        for table_id, key in gem_keys.items()
        if key.startswith("GEM_NAME_")
    }
    localized_gem_names = {key: value for key, value in localized_gem_names.items() if value}

    card_keys, card_localized = load_table_entries(localization_dir, "Cards Shared Data", "Cards_en")
    localized_card_names = {
        table_id: clean_localized_name(card_localized.get(table_id, ""))
        for table_id, key in card_keys.items()
        if is_name_key(key)
    }
    localized_card_names = {key: value for key, value in localized_card_names.items() if value}

    global_env = UnityPy.load(str(global_assets))
    global_objects = {obj.path_id: obj for obj in global_env.objects}
    script_names = {}
    for obj in global_env.objects:
        if obj.type.name != "MonoScript":
            continue
        tree = obj.read_typetree()
        script_names[obj.path_id] = tree.get("m_ClassName", "")

    gem_config_script_ids = {
        path_id for path_id, name in script_names.items() if name == "GemConfig"
    }
    card_config_script_ids = {
        path_id for path_id, name in script_names.items() if name in {"CardConfig", "FccConfig"}
    }

    config_inputs = [global_assets, game_data / "resources.assets"]
    config_inputs += sorted(game_data.glob("sharedassets*.assets"))
    card_names_by_path = build_card_name_lookup(
        config_inputs,
        global_env,
        card_config_script_ids,
        localized_card_names,
    )

    gem_text = {}
    diagnostics = []
    for input_path in config_inputs:
        if not input_path.exists():
            continue

        env = global_env if input_path == global_assets else UnityPy.load(str(input_path))
        local_objects = {obj.path_id: obj for obj in env.objects}
        for obj in env.objects:
            if obj.type.name != "MonoBehaviour":
                continue

            raw = obj.get_raw_data()
            if get_script_path_id(raw) not in gem_config_script_ids:
                continue

            gem_ids = sorted({match.group().decode("ascii") for match in GEM_ID_RE.finditer(raw)})
            if not gem_ids:
                continue

            gem_name = referenced_localized_name(raw, localized_gem_names)
            for gem_id in gem_ids:
                text = gem_text_overrides[gem_id] if gem_id in gem_text_overrides else build_gem_text(raw, gem_id, local_objects, global_objects, card_names_by_path, gem_name)
                if text or gem_id in gem_text_overrides:
                    gem_text[gem_id] = text
                else:
                    diagnostics.append(
                        {
                            "asset": input_path.name,
                            "pathId": obj.path_id,
                            "gemId": gem_id,
                            "reason": "no gem text",
                        }
                    )

    gem_text.update(gem_text_overrides)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(dict(sorted(gem_text.items())), indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(gem_text)} gem text mappings to {output_path}")
    if diagnostics:
        print(f"Unmapped gem text entries: {len(diagnostics)}")
        for item in diagnostics[:20]:
            print(f"  {item['asset']}:{item['pathId']}: {item['gemId']} ({item['reason']})")


if __name__ == "__main__":
    main()
