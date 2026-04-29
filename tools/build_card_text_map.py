import argparse
import json
import re
import struct
from pathlib import Path

import UnityPy

from display_overrides import load_text_overrides


CARD_ID_RE = re.compile(rb"(?:Card_[A-Z]_(?:[0-9]_[A-Za-z0-9]+|[A-Za-z0-9]+)|FCC_[A-Za-z0-9']+)")

EFFECT_TEXT = [
    ("Nosebleed.Pancake.GameCommands.DamageEffect", "Deal XX damage."),
    ("Nosebleed.Pancake.GameCommands.ArmorEffect", "Add XX Armor."),
    ("Nosebleed.Pancake.GameCommands.DrawEffect", "Draw XX card."),
    ("Nosebleed.Pancake.GameCommands.GainManaEffect", "Gain XX Mana."),
    ("Nosebleed.Pancake.GameCommands.CoinEffect", "Gain XX coins."),
    ("Nosebleed.Pancake.GameCommands.HealEffect", "Heal XX HP."),
    ("Nosebleed.Pancake.GameCommands.CurseEffect", "Gain XX Curse."),
    ("Nosebleed.Pancake.GameCommands.DurationEffect", "Increase duration by XX."),
    ("Nosebleed.Pancake.GameCommands.AreaEffect", "Increase area by XX."),
    ("Nosebleed.Pancake.GameCommands.WingsEffect", "Reduce Mana cost of next card played by {amount}.", "_reduceAmount"),
]

FCC_EFFECT_TEXT = {
    "AmountEffect": "Add XX Amount.",
    "AreaEffect": "Add XX Area.",
    "ArmorEffect": "Add XX Armor.",
    "CoinEffect": "Add XX coins.",
    "DealCountEffect": "Increase Hand by XX.",
    "DamageEffect": "Deal XX damage.",
    "DrawEffect": "Draw XX card.",
    "DurationEffect": "Gain XX Duration.",
    "ExperienceEffect": "Add XX XP.",
    "GainManaEffect": "Add XX Mana.",
    "GreedEffect": "Gain XX% more coins.",
    "GrowthEffect": "Gain XX XP Growth.",
    "HealEffect": "Heal XX.",
    "LuckEffect": "Add XX Luck.",
    "MightEffect": "Deal XX% more damage.",
    "RecoveryEffect": "Heal XX after encounter.",
    "ReduceCostEffect": "Reduce card cost by XX.",
    "RemoveIntentEffect": "Prevent XX enemies from attacking.",
    "RevivalEffect": "Add XX Revival.",
    "ReviveEffect": "Add XX Revival.",
    "WingsEffect": "Reduce card cost by XX.",
}

FCC_FIELD_EFFECTS = {
    "_amount": "AmountEffect",
    "_areaAmount": "AreaEffect",
    "_armorAmount": "ArmorEffect",
    "_coinAmount": "CoinEffect",
    "_countIncrease": "DealCountEffect",
    "_damageAmount": "DamageEffect",
    "_durationAmount": "DurationEffect",
    "_expAmount": "ExperienceEffect",
    "_gainAmount": "GainManaEffect",
    "_greedAmount": "GreedEffect",
    "_growthAmount": "GrowthEffect",
    "_healAmount": "HealEffect",
    "_luckAmount": "LuckEffect",
    "_mightAmount": "MightEffect",
    "_recoveryAmount": "RecoveryEffect",
    "_reduceAmount": "WingsEffect",
    "_reviveAmount": "RevivalEffect",
}

FCC_TRIGGER_TYPES = {
    "ArmorCardTypeTrigger": "blue",
    "AttackCardTypeTrigger": "red",
    "ManaCardTypeTrigger": "purple",
    "SpecialCardTypeTrigger": "yellow",
    "WildCostTypeTrigger": "wild",
}


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


def clean_text(value):
    text = str(value or "").strip()
    if not text or text.startswith("{db."):
        return ""

    replacements = {
        "{GlobalKeywords.Armor}": "Armor",
        "{GlobalKeywords.Mana}": "Mana",
        "{GlobalKeywords.Crawler}": "Crawler",
        "{FccModifierValue:N0}": "XX",
        "{FccDuration}": "XX",
        "{ModifyingStat}": "{stat}",
        "{CardType}": "{card type}",
    }
    for source, replacement in replacements.items():
        text = text.replace(source, replacement)

    text = re.sub(r"<br\s*/?>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"\s+", " ", text)
    text = text.strip()
    if text.startswith("(") and text.endswith(")"):
        text = text[1:-1].strip()
    return text


def has_effect(raw, effect_name):
    return effect_name.encode("utf-16le") in raw or effect_name.encode("ascii") in raw


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


def effect_sentences(raw):
    sentences = []
    for effect in EFFECT_TEXT:
        effect_name, text, *field_names = effect
        if not has_effect(raw, effect_name):
            continue

        if field_names:
            text = text.format(amount=amount_text(int_field_value(raw, field_names[0])))
        sentences.append(text)
    return sentences


def referenced_localized_entries(raw, card_keys, card_localized):
    entries = []
    seen = set()
    for offset in range(0, len(raw) - 8):
      table_id = struct.unpack_from("<Q", raw, offset)[0]
      if table_id in seen or table_id not in card_keys:
          continue
      seen.add(table_id)
      text = clean_text(card_localized.get(table_id, ""))
      if text:
          entries.append((card_keys[table_id], text))
    return entries


def crawler_text(card_id, all_localized):
    crawler_key = card_id.replace("FCC_", "").upper()
    text = clean_text(all_localized.get(f"{crawler_key}_SD", ""))
    if text:
        return text

    desc = clean_text(all_localized.get(f"{crawler_key}_DESC", ""))
    if desc:
        return desc
    return ""


def align(value, boundary):
    return (value + boundary - 1) // boundary * boundary


def get_odin_block(raw):
    if len(raw) < 40:
        return b""

    name_length = struct.unpack_from("<I", raw, 28)[0]
    if name_length > len(raw):
        return b""

    odin_length_offset = align(32 + name_length, 4) + 4
    if odin_length_offset + 4 > len(raw):
        return b""

    odin_length = struct.unpack_from("<I", raw, odin_length_offset)[0]
    block_start = odin_length_offset + 4
    block_end = block_start + odin_length
    if block_end > len(raw):
        return b""

    return raw[block_start:block_end]


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


def command_effects_from_block(block):
    effects = []
    for _, text in length_prefixed_utf16_strings(block):
        if "Nosebleed.Pancake.GameCommands." not in text and not text.endswith("Effect, Pancake"):
            continue

        effect_name = simple_type_name(text)
        if not effect_name.endswith("Effect") or effect_name == "CardEffect":
            continue
        if effect_name not in effects:
            effects.append(effect_name)

    if effects:
        return effects

    for field_name, effect_name in FCC_FIELD_EFFECTS.items():
        if field_name.encode("utf-16le") in block and effect_name not in effects:
            effects.append(effect_name)
    return effects


def trigger_type_from_block(block):
    for _, text in length_prefixed_utf16_strings(block):
        if "Nosebleed.Pancake.GameConfig.TriggerTypes." not in text:
            continue

        trigger_name = simple_type_name(text)
        if trigger_name in FCC_TRIGGER_TYPES:
            return FCC_TRIGGER_TYPES[trigger_name]
    return ""


def fcc_text_from_raw(raw):
    odin_block = get_odin_block(raw)
    if not odin_block:
        return ""

    fcc_actions_marker = "fccActions".encode("utf-16le")
    fcc_actions_offset = odin_block.find(fcc_actions_marker)
    if fcc_actions_offset < 0:
        return ""

    sentences = []
    for effect_name in command_effects_from_block(odin_block[:fcc_actions_offset]):
        effect_text = FCC_EFFECT_TEXT.get(effect_name)
        if effect_text:
            sentences.append(effect_text)

    trigger_marker = "_triggerType".encode("utf-16le")
    trigger_offsets = []
    search_offset = fcc_actions_offset
    while True:
        trigger_offset = odin_block.find(trigger_marker, search_offset)
        if trigger_offset < 0:
            break
        trigger_offsets.append(trigger_offset)
        search_offset = trigger_offset + len(trigger_marker)

    for index, trigger_offset in enumerate(trigger_offsets):
        next_trigger_offset = trigger_offsets[index + 1] if index + 1 < len(trigger_offsets) else len(odin_block)
        action_block = odin_block[trigger_offset:next_trigger_offset]
        trigger_type = trigger_type_from_block(action_block)
        for effect_name in command_effects_from_block(action_block):
            effect_text = FCC_EFFECT_TEXT.get(effect_name)
            if not effect_text:
                continue

            if trigger_type:
                effect_text = f"{effect_text.rstrip('.')} when a {trigger_type} card is played."
            sentences.append(effect_text)

    if any(command_effects_from_block(odin_block[offset:trigger_offsets[index + 1] if index + 1 < len(trigger_offsets) else len(odin_block)]) for index, offset in enumerate(trigger_offsets)):
        sentences.append("Duration: Triggers Z times.")

    return combine_sentences(sentences)


def best_localized_description(entries):
    for key, text in entries:
        upper_key = key.upper()
        if upper_key.endswith("_DESC") and not upper_key.endswith("_BIO"):
            return text

    for key, text in entries:
        if key.upper().endswith("_L0"):
            return text

    return ""


def combine_sentences(parts):
    sentences = []
    for part in parts:
        text = clean_text(part)
        if not text:
            continue
        if text in sentences:
            continue
        if text.lower() in {existing.lower() for existing in sentences}:
            continue
        sentences.append(text)
    return " ".join(sentence if sentence.endswith(".") else f"{sentence}." for sentence in sentences)


def is_redundant_localized_description(description, effects):
    normalized_description = re.sub(r"\bXX\b", "", description, flags=re.IGNORECASE)
    normalized_description = re.sub(r"\s+", " ", normalized_description).strip(" .").lower()
    normalized_description = normalized_description.replace("gain ", "add ")
    for effect in effects:
        normalized_effect = re.sub(r"\bXX\b", "", effect, flags=re.IGNORECASE)
        normalized_effect = re.sub(r"\s+", " ", normalized_effect).strip(" .").lower()
        normalized_effect = normalized_effect.replace("gain ", "add ")
        if normalized_description and normalized_description == normalized_effect:
            return True
    return False


def build_card_text(raw, card_id, entries, all_localized):
    if card_id.startswith("FCC_"):
        return fcc_text_from_raw(raw) or crawler_text(card_id, all_localized)

    effects = effect_sentences(raw)
    localized_description = best_localized_description(entries)
    if localized_description in effects or is_redundant_localized_description(localized_description, effects):
        localized_description = ""

    return combine_sentences([*effects, localized_description])


def main():
    parser = argparse.ArgumentParser(description="Build card ID to approximate rules text map.")
    parser.add_argument(
        "--game-data",
        default=r"C:\Program Files (x86)\Steam\steamapps\common\Vampire Crawlers\Vampire Crawlers_Data",
        help="Path to Vampire Crawlers_Data.",
    )
    parser.add_argument(
        "--output",
        default="public/assets/card-text.json",
        help="Output card text map path, relative to project root.",
    )
    parser.add_argument(
        "--text-overrides",
        default="data/display-overrides.csv",
        help="CSV file containing display overrides, relative to project root.",
    )
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[1]
    card_text_overrides = load_text_overrides(project_root, "card", args.text_overrides)
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
    all_localized = {
        key: card_localized.get(table_id, "")
        for table_id, key in card_keys.items()
        if card_localized.get(table_id, "")
    }

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

    card_text = {}
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

            entries = referenced_localized_entries(raw, card_keys, card_localized)
            for card_id in card_ids:
                text = card_text_overrides[card_id] if card_id in card_text_overrides else build_card_text(raw, card_id, entries, all_localized)
                if text or card_id in card_text_overrides:
                    card_text[card_id] = text

    card_text.update(card_text_overrides)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(dict(sorted(card_text.items())), indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(card_text)} card text mappings to {output_path}")


if __name__ == "__main__":
    main()
