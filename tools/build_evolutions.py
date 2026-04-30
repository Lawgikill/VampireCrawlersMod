import argparse
import csv
import json
from pathlib import Path

from display_overrides import build_name_id_index, normalize_name


def split_recipe_names(value):
    return [
        [name.strip() for name in part.split("|") if name.strip()]
        for part in str(value or "").split("+")
        if part.strip()
    ]


def load_card_display_names(project_root):
    path = project_root / "public" / "assets" / "card-names.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_card_name(name, card_name_index, card_display_names):
    ids = card_name_index.get(normalize_name(name), [])
    if not ids:
        return ""

    normalized = normalize_name(name)
    for card_id in ids:
        if normalize_name(card_display_names.get(card_id, "")) == normalized:
            return card_id
    for card_id in ids:
        if card_display_names.get(card_id):
            return card_id
    return ids[0]


def main():
    parser = argparse.ArgumentParser(description="Build evolution chart JSON from the editable name-based CSV.")
    parser.add_argument(
        "--input",
        default="data/evolutions.csv",
        help="Evolution CSV path, relative to project root.",
    )
    parser.add_argument(
        "--output",
        default="public/assets/evolutions.json",
        help="Output JSON path, relative to project root.",
    )
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parents[1]
    input_path = Path(args.input)
    if not input_path.is_absolute():
        input_path = project_root / input_path
    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = project_root / output_path

    name_id_index = build_name_id_index(project_root)
    card_name_index = {
        name_key: ids
        for (kind, name_key), ids in name_id_index.items()
        if kind == "card"
    }
    card_display_names = load_card_display_names(project_root)

    recipes = []
    diagnostics = []
    with input_path.open("r", encoding="utf-8-sig", newline="") as handle:
        for line_number, row in enumerate(csv.DictReader(handle), start=2):
            input_name_groups = split_recipe_names(row.get("input_names"))
            result_name = (row.get("result_name") or "").strip()
            source_note = (row.get("source_note") or "").strip()

            resolved_inputs = []
            has_unresolved = False
            for group in input_name_groups:
                resolved_group = []
                for name in group:
                    card_id = resolve_card_name(name, card_name_index, card_display_names)
                    if card_id:
                        resolved_group.append(card_id)
                    else:
                        has_unresolved = True
                        diagnostics.append(f"line {line_number}: input name not found: {name}")
                if resolved_group:
                    resolved_inputs.append(resolved_group)

            result_id = resolve_card_name(result_name, card_name_index, card_display_names)
            if not result_id:
                has_unresolved = True
                diagnostics.append(f"line {line_number}: result name not found: {result_name}")

            if not has_unresolved and resolved_inputs and result_id:
                recipes.append({
                    "inputs": resolved_inputs,
                    "resultId": result_id,
                    "sourceNote": source_note,
                })

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(recipes, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(recipes)} evolution recipes to {output_path}")
    if diagnostics:
        print(f"Unresolved evolution names: {len(diagnostics)}")
        for item in diagnostics[:30]:
            print(f"  {item}")


if __name__ == "__main__":
    main()
