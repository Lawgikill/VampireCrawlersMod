import argparse
import json
import re
import struct
from pathlib import Path

import UnityPy


GEM_ID_RE = re.compile(rb"GemConfig_[A-Za-z0-9_]+")


def get_script_path_id(raw):
    if len(raw) < 28:
        return None
    return struct.unpack_from("<q", raw, 20)[0]


def iter_pptrs(raw):
    for offset in range(0, len(raw) - 12, 4):
        file_id = struct.unpack_from("<i", raw, offset)[0]
        path_id = struct.unpack_from("<q", raw, offset + 4)[0]
        yield offset, file_id, path_id


def load_manifest(manifest_path):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    return {
        item["pathId"]: item.get("path") or item.get("duplicateOf")
        for item in manifest
        if item.get("path") or item.get("duplicateOf")
    }


def main():
    parser = argparse.ArgumentParser(description="Build gem ID to sprite map for Vampire Crawlers.")
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
        default="public/assets/gem-map.json",
        help="Output gem map path, relative to project root.",
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

    sprite_paths = load_manifest(manifest_path)
    global_env = UnityPy.load(str(global_assets))
    script_names = {}
    for obj in global_env.objects:
        if obj.type.name != "MonoScript":
            continue
        tree = obj.read_typetree()
        script_names[obj.path_id] = tree.get("m_ClassName", "")

    gem_config_script_ids = {
        path_id for path_id, name in script_names.items() if name == "GemConfig"
    }

    gem_map = {}
    diagnostics = []
    config_inputs = [global_assets, game_data / "resources.assets"]
    config_inputs += sorted(game_data.glob("sharedassets*.assets"))

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

            sprite_refs = []
            for _, file_id, path_id in iter_pptrs(raw):
                target = local_objects.get(path_id) if file_id == 0 else None
                if target and target.type.name == "Sprite" and path_id in sprite_paths:
                    sprite_refs.append(path_id)

            if not sprite_refs:
                diagnostics.append(
                    {
                        "asset": input_path.name,
                        "pathId": obj.path_id,
                        "gemIds": gem_ids,
                        "reason": "no sprite ref",
                    }
                )
                continue

            art_path = sprite_paths[sprite_refs[-1]]
            for gem_id in gem_ids:
                gem_map[gem_id] = art_path

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(dict(sorted(gem_map.items())), indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(gem_map)} gem art mappings to {output_path}")
    if diagnostics:
        print(f"Unmapped gem configs: {len(diagnostics)}")
        for item in diagnostics[:20]:
            print(f"  {item['asset']}:{item['pathId']}: {', '.join(item['gemIds'])} ({item['reason']})")


if __name__ == "__main__":
    main()
