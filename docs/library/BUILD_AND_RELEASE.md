# Build And Release Notes

## Golden Rule

Do not rebuild release exes unless the user explicitly asks.

For code-only changes, run syntax/unit-style checks and stop. When the user asks to rebuild, follow the full release sequence below.

## Versioning

Use npm patch versioning unless the user asks otherwise:

```powershell
npm version patch --no-git-tag-version
```

This updates both `package.json` and `package-lock.json`.

## Release Build Sequence

For a distributable Windows release:

```powershell
python -m pip install pyinstaller UnityPy fmod_toolkit archspec pillow
npm run build-asset-builder
npm run stage-live-bridge
npm run build:win
```

Why two build steps?

- `build-asset-builder` creates `bin\vampire-crawlers-asset-builder.exe`.
- `stage-live-bridge` stages the current bridge plugin DLL into `resources\live-bridge`.
- `build:win` packages those helpers into Electron via `extraResources`.

If you skip `build-asset-builder`, other users without Python installed will fail when pressing `Rebuild Local Data`.
If you skip `stage-live-bridge`, users will not receive the latest live bridge plugin in the app installer.

For a fully self-contained BepInEx release payload, stage from a clean BepInEx
BE IL2CPP install before `build:win`:

```powershell
python tools\stage_live_bridge_payload.py --with-bepinex
```

This copies only `.doorstop_version`, `doorstop_config.ini`, `winhttp.dll`,
`dotnet/**`, `BepInEx/core/**`, and the bridge plugin. It intentionally does
not copy generated runtime folders such as `BepInEx\cache`,
`BepInEx\interop`, logs, or user config.

## Expected Outputs

Release artifacts:

```text
dist\Vampire-Crawlers-Deck-Tracker-Setup-<version>.exe
dist\Vampire-Crawlers-Deck-Tracker-Setup-<version>.exe.blockmap
dist\latest.yml
dist\win-unpacked\
```

The helper should be packaged at:

```text
dist\win-unpacked\resources\asset-builder\vampire-crawlers-asset-builder.exe
```

The live bridge payload should be packaged at:

```text
dist\win-unpacked\resources\live-bridge\BepInEx\plugins\VampireCrawlers.LiveBridge\VampireCrawlers.LiveBridge.dll
```

If `--with-bepinex` was used, the release payload should also include:

```text
dist\win-unpacked\resources\live-bridge\winhttp.dll
dist\win-unpacked\resources\live-bridge\doorstop_config.ini
dist\win-unpacked\resources\live-bridge\dotnet\
dist\win-unpacked\resources\live-bridge\BepInEx\core\
```

The fallback cost table should be packaged at:

```text
dist\win-unpacked\resources\app\public\assets\card-costs.json
```

The app-owned text assets should be packaged at:

```text
dist\win-unpacked\resources\app\public\assets\card-text.json
dist\win-unpacked\resources\app\public\assets\evolutions.json
dist\win-unpacked\resources\app\public\assets\gem-text.json
dist\win-unpacked\resources\app\public\assets\text-meta.json
```

The app should **not** package:

```text
dist\win-unpacked\resources\app\public\assets\art\
dist\win-unpacked\resources\app\public\assets\card-map.json
dist\win-unpacked\resources\app\public\assets\card-names.json
dist\win-unpacked\resources\app\public\assets\gem-map.json
dist\win-unpacked\resources\app\public\assets\art-manifest.json
```

## Post-Build Verification

After `npm run build-asset-builder`:

```powershell
bin\vampire-crawlers-asset-builder.exe --help
```

After `npm run build:win`:

```powershell
Get-ChildItem dist -Filter 'Vampire-Crawlers-Deck-Tracker-Setup-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object Name,Length,LastWriteTime

Test-Path 'dist\win-unpacked\resources\asset-builder\vampire-crawlers-asset-builder.exe'
Test-Path 'dist\win-unpacked\resources\app\public\assets\card-costs.json'
Test-Path 'dist\win-unpacked\resources\app\public\assets\art'
Test-Path 'dist\win-unpacked\resources\app\public\assets\card-map.json'
Test-Path 'dist\win-unpacked\resources\app\public\assets\card-names.json'
Test-Path 'dist\win-unpacked\resources\app\public\assets\card-text.json'
Test-Path 'dist\win-unpacked\resources\app\public\assets\evolutions.json'
Test-Path 'dist\win-unpacked\resources\app\public\assets\gem-map.json'
Test-Path 'dist\win-unpacked\resources\app\public\assets\gem-text.json'
Test-Path 'dist\win-unpacked\resources\app\public\assets\text-meta.json'
Test-Path 'dist\win-unpacked\resources\live-bridge\BepInEx\plugins\VampireCrawlers.LiveBridge\VampireCrawlers.LiveBridge.dll'
Test-Path 'dist\win-unpacked\resources\live-bridge\winhttp.dll'
Test-Path 'dist\latest.yml'
```

Expected booleans:

```text
installer exe: true
helper: true
card-costs.json: true
art folder: false
card-map.json: false
card-names.json: false
card-text.json: true
evolutions.json: true
gem-map.json: false
gem-text.json: true
text-meta.json: true
live bridge DLL: true
BepInEx loader winhttp.dll: true if built with --with-bepinex, false for DLL-only payloads
latest.yml: true
```

GitHub Releases for updater-enabled builds must upload the installer exe, its `.blockmap`, and `latest.yml`.

The v1.0.0 release was published with GitHub CLI:

```powershell
& 'C:\Program Files\GitHub CLI\gh.exe' release create v1.0.0 `
  'dist\Vampire-Crawlers-Deck-Tracker-Setup-1.0.0.exe' `
  'dist\Vampire-Crawlers-Deck-Tracker-Setup-1.0.0.exe.blockmap' `
  'dist\latest.yml' `
  --repo Lawgikill/VampireCrawlersMod `
  --title 'v1.0.0' `
  --notes-file <release-notes.md>
```

If `gh` is installed but not on PATH, check `C:\Program Files\GitHub CLI\gh.exe`.

Check known cost entries:

```powershell
Select-String -Path 'dist\win-unpacked\resources\app\public\assets\card-costs.json' -Pattern 'Card_A_1_MagicWand|Card_A_1_KingBible|Card_A_3_NoFuture'
```

Expected values:

```text
"Card_A_1_KingBible": 1,
"Card_A_1_MagicWand": 0,
"Card_A_3_NoFuture": 3,
```

## Known Build Warnings

Electron builder currently warns about no custom icon and uses the default Electron icon. That is expected for now.

If PyInstaller is called directly instead of through `npm run build-asset-builder`,
it may warn:

```text
Library fmod.dll required via ctypes not found
```

The npm script uses `tools/build_asset_builder.py`, which points `PYFMODEX_DLL_PATH`
and `PATH` at `fmod_toolkit`'s bundled DLL before analysis so this warning should
not appear during normal builds. If it appears during a direct/manual PyInstaller
run, the built helper must be tested with a real extraction. Sprite decoding
depends on `fmod_toolkit` and `archspec` data through UnityPy's texture path. If
those are not bundled, the helper can read assets and build costs but export `0`
sprites.

## Python/PyInstaller Notes

`pyinstaller.exe` might not be on PATH after install. The npm script intentionally uses:

```powershell
python tools\build_asset_builder.py
```

The wrapper calls `python -m PyInstaller` and includes:

```powershell
--collect-all UnityPy --collect-all fmod_toolkit --collect-data archspec
```

These are required. Without UnityPy resources, the helper can fail at startup with:

```text
ModuleNotFoundError: No module named 'UnityPy.resources'
```

Without `fmod_toolkit` binaries and `archspec` data, image decoding can fail inside the frozen helper and produce no art mappings.

## Generated Files And Git Hygiene

Ignored/generated:

```text
dist/
build/
*.spec
bin/vampire-crawlers-asset-builder.exe
public/assets/art/
public/assets/art-manifest.json
public/assets/card-map.json
public/assets/card-names.json
public/assets/gem-map.json
public/assets/contact-sheet-*.png
```

Tracked intentionally:

```text
public/assets/card-costs.json
public/assets/card-text.json
public/assets/evolutions.json
public/assets/gem-text.json
public/assets/text-meta.json
data/display-overrides.csv
data/evolutions.csv
resources/live-bridge/BepInEx/plugins/VampireCrawlers.LiveBridge/VampireCrawlers.LiveBridge.dll
bin/.gitkeep
```

If future Codex sees a dirty worktree with generated `dist/`, `build/`, or `bin/*.exe`, do not treat those as source edits.
