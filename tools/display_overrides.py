import csv
import json
from pathlib import Path


DEFAULT_DISPLAY_OVERRIDES_PATH = Path("data/display-overrides.csv")
DEFAULT_GAME_ITEM_NAMES_PATH = Path("data/game-item-names.csv")


def normalize_display_text(value):
    return (
        (value or "")
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("\\r", "\n")
        .strip()
    )


def normalize_tooltip_text(value):
    return normalize_display_text(value).replace("|", "\n")


def normalize_name(value):
    return " ".join((value or "").strip().split()).casefold()


def resolve_path(project_root, path):
    resolved = Path(path)
    if not resolved.is_absolute():
        resolved = project_root / resolved
    return resolved


def load_game_item_name_rows(project_root, path=DEFAULT_GAME_ITEM_NAMES_PATH):
    item_path = resolve_path(project_root, path)
    if not item_path.exists():
        return []

    for encoding in ("utf-8-sig", "cp1252"):
        try:
            with item_path.open("r", encoding=encoding, newline="") as file:
                return list(csv.DictReader(file))
        except UnicodeDecodeError:
            continue
    raise UnicodeDecodeError("unknown", b"", 0, 1, f"Unable to decode {item_path}")


def build_name_id_index(project_root, path=DEFAULT_GAME_ITEM_NAMES_PATH):
    index = {}
    for row in load_game_item_name_rows(project_root, path):
        kind = (row.get("kind") or "").strip().lower()
        item_id = (row.get("id") or "").strip()
        name = (row.get("name") or "").strip()
        if not kind or not item_id or not name:
            continue
        index.setdefault((kind, normalize_name(name)), []).append(item_id)
    return index


def mapped_ids_for_row(row, kind, name_id_index):
    item_id = (row.get("id") or "").strip()
    if item_id:
        return [item_id]

    name = (row.get("name") or "").strip()
    if not name:
        return []
    return name_id_index.get((kind, normalize_name(name)), [])


def row_applies_to_kind(row, kind):
    row_kind = (row.get("kind") or "").strip().lower()
    if row_kind:
        return row_kind == kind

    color = (row.get("color") or "").strip()
    if color:
        return kind == "card"
    return kind == "gem"


def load_text_overrides(project_root, kind, path=DEFAULT_DISPLAY_OVERRIDES_PATH):
    """Load text overrides from the editable full display override sheet.

    The CSV may include display columns such as `name`, `gold`, and `color`;
    text builders only consume kind, id, and text.
    """
    override_path = resolve_path(project_root, path)
    if not override_path.exists():
        return {}

    overrides = {}
    name_id_index = build_name_id_index(project_root)
    with override_path.open("r", encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            if not row_applies_to_kind(row, kind):
                continue
            text = normalize_display_text(row.get("text"))
            for item_id in mapped_ids_for_row(row, kind, name_id_index):
                overrides[item_id] = text
    return overrides


def load_text_metadata(project_root, path=DEFAULT_DISPLAY_OVERRIDES_PATH):
    override_path = resolve_path(project_root, path)
    if not override_path.exists():
        return {}

    metadata = {}
    name_id_index = build_name_id_index(project_root)
    with override_path.open("r", encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            entry = {}
            gold = (row.get("gold") or "").strip()
            if gold:
                entry["gold"] = [token.strip() for token in gold.split("|") if token.strip()]
            tooltip = normalize_tooltip_text(row.get("tooltip"))
            if tooltip:
                entry["tooltip"] = tooltip
            color = (row.get("color") or "").strip().lower()
            if color:
                entry["color"] = color
            if entry:
                for kind in ["card", "gem"]:
                    if not row_applies_to_kind(row, kind):
                        continue
                    for item_id in mapped_ids_for_row(row, kind, name_id_index):
                        metadata[item_id] = entry
    return metadata


def write_text_metadata(project_root, output_path, path=DEFAULT_DISPLAY_OVERRIDES_PATH):
    output = Path(output_path)
    if not output.is_absolute():
        output = project_root / output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(dict(sorted(load_text_metadata(project_root, path).items())), indent=2) + "\n", encoding="utf-8")
