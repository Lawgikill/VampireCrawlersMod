import os
import subprocess
import sys
from pathlib import Path


def configure_fmod_path():
    try:
        from fmod_toolkit.importer import get_fmod_path_for_system
    except Exception:
        return

    fmod_path = Path(get_fmod_path_for_system())
    if not fmod_path.exists():
        return

    os.environ.setdefault("PYFMODEX_DLL_PATH", str(fmod_path))
    os.environ["PATH"] = f"{fmod_path.parent}{os.pathsep}{os.environ.get('PATH', '')}"


def main():
    configure_fmod_path()
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--clean",
        "--onefile",
        "--collect-all",
        "UnityPy",
        "--collect-all",
        "fmod_toolkit",
        "--collect-data",
        "archspec",
        "--name",
        "vampire-crawlers-asset-builder",
        "--distpath",
        "bin",
        "tools\\build_local_data.py",
    ]
    raise SystemExit(subprocess.call(command))


if __name__ == "__main__":
    main()
