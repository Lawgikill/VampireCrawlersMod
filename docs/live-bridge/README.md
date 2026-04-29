# Vampire Crawlers Live Bridge

This is the optional path for true combat-live pile state.

The desktop tracker still works without it by reading the save file. If this
bridge is installed and writes a fresh file, `/api/deck` prefers:

```text
%APPDATA%\VampireCrawlersDeckTracker\live-state.json
```

Expected JSON shape:

```json
{
  "schemaVersion": 1,
  "source": "bepinex",
  "updatedAt": "2026-04-28T13:45:00.0000000Z",
  "piles": [
    {
      "pileId": "HandPile",
      "cards": [
        {
          "CardConfigId": "Card_A_1_KingBible",
          "BaseCardConfigId": "Card_A_1_KingBible",
          "CardGuid": "",
          "ManaCostModifier": 0,
          "TempManaCostModifier": 0,
          "ConfusedManaCostModifier": 0,
          "GemIds": []
        }
      ]
    }
  ]
}
```

The tracker considers the bridge active only while the file is less than five
seconds old. If it goes stale, the tracker falls back to the save file.

## Current State

`live-bridge/VampireCrawlers.LiveBridge` is a first-pass BepInEx IL2CPP plugin
implementation. It reads the generated IL2CPP types for hand/draw/discard/
combo/FCC/throwing pile models and emits the JSON above.

Release builds can package the bridge payload under `resources/live-bridge`.
On app startup, and after game folder selection, the desktop app silently copies
that payload into the configured Vampire Crawlers game directory. `File >
Install/Update Live Bridge` remains as a manual fallback.

## Local Test Setup

Vampire Crawlers currently runs on Unity `6000.0.62f1` with IL2CPP metadata
version `31`. BepInEx `6.0.0-pre.2` fails on that metadata version. Use BepInEx
BE `#755` or newer, specifically a `Unity.IL2CPP-win-x64` build.

After one successful BepInEx launch, build and deploy with:

```powershell
dotnet build .\live-bridge\VampireCrawlers.LiveBridge\VampireCrawlers.LiveBridge.csproj -p:BepInExDir="C:\Program Files (x86)\Steam\steamapps\common\Vampire Crawlers\BepInEx"
Copy-Item .\live-bridge\VampireCrawlers.LiveBridge\bin\Debug\net6.0\VampireCrawlers.LiveBridge.dll "C:\Program Files (x86)\Steam\steamapps\common\Vampire Crawlers\BepInEx\plugins\VampireCrawlers.LiveBridge\VampireCrawlers.LiveBridge.dll" -Force
```

The plugin loads at game startup. If no combat pile models exist yet, it will
not write `live-state.json` until the player enters a state where those models
are alive.

## Release Payload

Stage the bridge DLL for packaging with:

```powershell
npm run stage-live-bridge
```

For a self-contained payload that also includes clean BepInEx loader files from
the configured local game folder:

```powershell
python tools\stage_live_bridge_payload.py --with-bepinex
```

Do not stage generated runtime folders such as `BepInEx\cache`,
`BepInEx\interop`, logs, or user config.
