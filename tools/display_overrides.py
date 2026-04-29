import csv
import json
from pathlib import Path


DEFAULT_DISPLAY_OVERRIDES_PATH = Path("data/display-overrides.csv")


def normalize_display_text(value):
    return (
        (value or "")
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("\\r", "\n")
        .strip()
    )


def load_text_overrides(project_root, kind, path=DEFAULT_DISPLAY_OVERRIDES_PATH):
    """Load text overrides from the editable full display override sheet.

    The CSV may include display columns such as `name`, `gold`, and `color`;
    text builders only consume kind, id, and text.
    """
    override_path = Path(path)
    if not override_path.is_absolute():
        override_path = project_root / override_path
    if not override_path.exists():
        return {}

    overrides = {}
    with override_path.open("r", encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            if (row.get("kind") or "").strip().lower() != kind:
                continue
            item_id = (row.get("id") or "").strip()
            text = normalize_display_text(row.get("text"))
            if item_id:
                overrides[item_id] = text
    return overrides


def load_text_metadata(project_root, path=DEFAULT_DISPLAY_OVERRIDES_PATH):
    override_path = Path(path)
    if not override_path.is_absolute():
        override_path = project_root / override_path
    if not override_path.exists():
        return {}

    metadata = {}
    with override_path.open("r", encoding="utf-8-sig", newline="") as file:
        for row in csv.DictReader(file):
            item_id = (row.get("id") or "").strip()
            if not item_id:
                continue
            entry = {}
            gold = (row.get("gold") or "").strip()
            if gold:
                entry["gold"] = [token.strip() for token in gold.split("|") if token.strip()]
            color = (row.get("color") or "").strip().lower()
            if (row.get("kind") or "").strip().lower() == "card" and color:
                entry["color"] = color
            if entry:
                metadata[item_id] = entry
    return metadata


def write_text_metadata(project_root, output_path, path=DEFAULT_DISPLAY_OVERRIDES_PATH):
    output = Path(output_path)
    if not output.is_absolute():
        output = project_root / output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(dict(sorted(load_text_metadata(project_root, path).items())), indent=2) + "\n", encoding="utf-8")
