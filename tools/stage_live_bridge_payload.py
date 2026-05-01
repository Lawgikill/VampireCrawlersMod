import argparse
import shutil
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_GAME_DIR = Path("C:/Program Files (x86)/Steam/steamapps/common/Vampire Crawlers")
DEFAULT_OUTPUT = PROJECT_ROOT / "resources" / "live-bridge"
BRIDGE_DLL = (
    PROJECT_ROOT
    / "live-bridge"
    / "VampireCrawlers.LiveBridge"
    / "bin"
    / "Release"
    / "net6.0"
    / "VampireCrawlers.LiveBridge.dll"
)
PLUGIN_OUTPUT = (
    "BepInEx"
    / Path("plugins")
    / "VampireCrawlers.LiveBridge"
    / "VampireCrawlers.LiveBridge.dll"
)


def copy_path(source, target):
    if source.is_dir():
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(source, target)
        return

    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def main():
    parser = argparse.ArgumentParser(description="Stage clean BepInEx + live bridge files for packaging.")
    parser.add_argument("--game-dir", type=Path, default=DEFAULT_GAME_DIR)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--bridge-dll", type=Path, default=BRIDGE_DLL)
    parser.add_argument(
        "--with-bepinex",
        action="store_true",
        help="Also copy clean BepInEx loader files from --game-dir.",
    )
    args = parser.parse_args()

    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)

    if not args.bridge_dll.exists():
        raise FileNotFoundError(f"Bridge DLL not found: {args.bridge_dll}")
    copy_path(args.bridge_dll, output / PLUGIN_OUTPUT)

    if args.with_bepinex:
        required = [
            Path(".doorstop_version"),
            Path("doorstop_config.ini"),
            Path("winhttp.dll"),
            Path("dotnet"),
            Path("BepInEx") / "core",
        ]
        for relative_path in required:
            source = args.game_dir / relative_path
            if not source.exists():
                raise FileNotFoundError(f"BepInEx payload file not found: {source}")
            copy_path(source, output / relative_path)

    print(f"Staged live bridge payload at {output}")


if __name__ == "__main__":
    main()
