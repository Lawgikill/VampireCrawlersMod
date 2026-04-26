import argparse
import hashlib
import json
from pathlib import Path

import UnityPy


DEFAULT_GAME_DIR = Path(
    r"C:\Program Files (x86)\Steam\steamapps\common\Vampire Crawlers"
)


def safe_name(value: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in value.strip())
    return cleaned.strip("._") or "unnamed"


def image_hash(image) -> str:
    rgba = image.convert("RGBA")
    return hashlib.sha1(rgba.tobytes()).hexdigest()


def sprite_name(obj, data) -> str:
    name = getattr(data, "name", "") or ""
    if name:
        return name

    try:
        return obj.read_typetree().get("m_Name", "") or ""
    except Exception:
        return ""


def export_sprites(input_paths, output_dir: Path, min_size: int):
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest = []
    seen_hashes = {}
    sprite_count = 0
    image_failures = 0
    first_image_error = None

    for input_path in input_paths:
        try:
            env = UnityPy.load(str(input_path))
        except Exception as error:
            print(f"skip {input_path}: {error}")
            continue

        print(f"reading {input_path.name} ({len(env.objects)} objects)")
        for obj in env.objects:
            if obj.type.name != "Sprite":
                continue

            sprite_count += 1
            try:
                data = obj.read()
                image = data.image
                if image is None:
                    continue
            except Exception as error:
                image_failures += 1
                if first_image_error is None:
                    first_image_error = error
                continue

            width, height = image.size
            if width < min_size or height < min_size:
                continue

            name = sprite_name(obj, data)
            digest = image_hash(image)
            if digest in seen_hashes:
                manifest.append(
                    {
                        "bundle": input_path.name,
                        "pathId": obj.path_id,
                        "name": name,
                        "width": width,
                        "height": height,
                        "sha1": digest,
                        "duplicateOf": seen_hashes[digest],
                    }
                )
                continue

            label = safe_name(name or f"sprite_{obj.path_id}")
            filename = f"{label}_{digest[:10]}.png"
            relative_path = f"assets/art/{filename}"
            image.save(output_dir / filename)
            seen_hashes[digest] = relative_path

            manifest.append(
                    {
                        "bundle": input_path.name,
                        "pathId": obj.path_id,
                        "name": name,
                        "width": width,
                        "height": height,
                    "sha1": digest,
                    "path": relative_path,
                }
            )

    if sprite_count and image_failures == sprite_count:
        raise RuntimeError(
            "UnityPy found sprites but could not decode any images. "
            f"First image error: {first_image_error!r}"
        )

    if image_failures:
        print(f"sprite image decode failures: {image_failures} of {sprite_count}")

    return manifest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--game-dir", type=Path, default=DEFAULT_GAME_DIR)
    parser.add_argument("--out", type=Path, default=Path("public/assets/art"))
    parser.add_argument("--manifest", type=Path, default=Path("public/assets/art-manifest.json"))
    parser.add_argument("--min-size", type=int, default=24)
    args = parser.parse_args()

    data_dir = args.game_dir / "Vampire Crawlers_Data"
    inputs = list((data_dir / "StreamingAssets" / "aa" / "StandaloneWindows64").glob("*.bundle"))
    inputs += [data_dir / "globalgamemanagers.assets"]
    inputs += [data_dir / "resources.assets"]
    inputs += sorted(data_dir.glob("sharedassets*.assets"))

    manifest = export_sprites(inputs, args.out, args.min_size)
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    exported = sum(1 for item in manifest if "path" in item)
    duplicates = sum(1 for item in manifest if "duplicateOf" in item)
    print(f"exported {exported} unique sprites, skipped {duplicates} duplicates")
    print(f"manifest: {args.manifest}")


if __name__ == "__main__":
    main()
