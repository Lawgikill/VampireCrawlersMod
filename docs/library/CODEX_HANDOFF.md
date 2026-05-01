# Codex Handoff

This project is a read-only second-screen deck tracker for the Unity game **Vampire Crawlers**. The tracker never edits saves. For true combat-live hand state, it can install/update a bundled BepInEx IL2CPP live bridge into the configured game folder.

The current app prefers the live bridge JSON when fresh, falls back to the active save file when the bridge is stale/missing, maps cards to extracted local art, and displays a sortable compact deck view in Electron.

## Current State

- Version is currently `1.1.9`.
- The app has both browser mode and Electron desktop mode.
- Browser mode:
  - `npm start`
  - opens `http://127.0.0.1:5177`
- Desktop dev mode:
  - `npm run desktop`
- Release build:
  - `npm run build-asset-builder`
  - `npm run stage-live-bridge`
  - `npm run build:win`
- Latest release artifacts are in `dist/`:
  - NSIS installer only
  - installer blockmap
  - `latest.yml` for electron-updater

## User Preferences And Working Style

- The user is iterating fast and testing live.
- They care about correctness in deck/cost tracking more than polish right now.
- Do not rebuild the exe unless the user explicitly asks.
- When rebuilding for other users, always build the asset helper first.
- Do not produce or publish portable builds; the supported release format is the full installer.
- Upload `latest.yml` with each GitHub Release or installed apps will not see updates.
- Startup setup now runs automatically in Electron: it prompts only for missing game/save paths, rebuilds missing local art/data, and installs or updates the live bridge behind a blocking progress modal. The Local setup panel can still be hidden forever via `hideSetupPanel` in config; do not remove the File menu rebuild command.
- Be direct about uncertainty. Earlier we treated card ID numbers as mana costs and that was wrong.
- Keep generated game art out of the shipped app.

## Important Paths

Default Steam install:

```text
C:\Program Files (x86)\Steam\steamapps\common\Vampire Crawlers
```

Game data:

```text
C:\Program Files (x86)\Steam\steamapps\common\Vampire Crawlers\Vampire Crawlers_Data
```

Default save:

```text
%USERPROFILE%\AppData\LocalLow\Nosebleed Interactive\Vampire Crawlers\Save\SaveProfile0.save
```

App config and generated data:

```text
%APPDATA%\VampireCrawlersDeckTracker
%APPDATA%\VampireCrawlersDeckTracker\generated\assets
```

Generated local files:

```text
art-manifest.json
card-map.json
card-costs.json
card-names.json
art\*.png
```

## High-Level Flow

1. `src/main.js` starts Electron and launches the local HTTP server from `server.js`.
2. `src/config.js` auto-detects game install and save file.
3. `public/app.js` asks the main process to run startup setup through `run-startup-setup`.
4. Startup setup prompts only for missing game/save paths, rebuilds generated local data if required, and installs/updates the live bridge if the bundled payload differs from the game folder.
5. `server.js` reads fresh live bridge JSON on each `/api/deck` request when available; otherwise it falls back to the save file.
6. `public/app.js` polls `/api/deck` every two seconds after setup finishes.
7. Art is displayed from a generated local `card-map.json`.
8. Cost data comes from `card-costs.json`.
9. Display names come from generated local `card-names.json`.
10. Card rules text comes from bundled app-owned `public/assets/card-text.json`.
11. Filled gem slot art comes from generated local `gem-map.json`.
12. Gem rules text comes from bundled app-owned `public/assets/gem-text.json`.
13. Display metadata comes from bundled app-owned `public/assets/text-meta.json`.
14. Evolution cheat sheet data comes from bundled app-owned `public/assets/evolutions.json`.
15. `Rebuild Local Data` runs a bundled helper exe in packaged builds.
16. Users can run `Rebuild Local Data` from the File menu even after hiding the Local setup panel.
17. In live-bridge mode, the frontend can send experimental dry-run bridge commands through `/api/live-command`.
18. The BepInEx bridge polls `%APPDATA%\VampireCrawlersDeckTracker\command.json` and writes `%APPDATA%\VampireCrawlersDeckTracker\command-result.json`.

## Things That Are Known Fragile

- The live bridge is combat-live when BepInEx is installed and the game has active pile models. Save polling is only as real-time as the game's save writes and remains the fallback path.
- The live bridge plugin also draws a small two-line in-game hand-mana overlay near the lower right combat UI area. IMGUI text worked, but IMGUI backgrounds did not: `GUI.DrawTexture` threw `NotSupportedException`, and `GUI.Label`/`GUI.Box` style backgrounds were not visible. The working overlay is now a `ScreenSpaceOverlay` Unity UI `Canvas` with an opaque `Image` panel and `Text` child, styled to resemble the **End Turn** button.
- The app-to-game bridge command channel is diagnostic only. `play-card` commands match a live hand card and log/return candidate play-related methods; they do not currently invoke gameplay.
- `CardGuid` needs to serialize as a real value for command targeting. If it falls back to a type name, use the command result plus hand index only as a temporary diagnostic.
- Cracked/shattered card visuals appear to be separate from `IsBroken`. The bridge now exports `CardCrackStage` via reflection fallbacks when available; `server.js` already normalizes it as `crackStage`.
- The card art mapping is reverse-engineered from Unity assets and is not perfect for every future card/config.
- Unity/Odin serialized `CardConfig` data is partially custom; do not assume `read_typetree()` will expose all fields.
- Card IDs like `Card_A_1_MagicWand` are not reliable for mana cost. MagicWand's true base cost is `0`.
- Wild/event cards such as `Card_W_Combo`, `Card_E_BagOfCoins`, and `Card_E_Vacuum` display with cost `W`.
- Event cards can use ids without a numeric tier, such as `Card_E_LittleClover` and `Card_E_Orologion`; the builder regex must support that shorter shape.
- `FCC_*` crawler cards do have real mana costs, but not from generated `card-costs.json`. The server reads `RunMetaSaveData.SelectedPartyFccIds`: first selected crawler costs `0`, other selected crawlers cost `1`.
- The Costs panel separates crawler buckets from normal deck mana buckets. `Wild` and normal numeric mana buckets render as a histogram; `Crawler N` buckets render as rows.
- `GemConfig_SetCostType_Wild` changes a card's effective cost to `W`; this must happen in server-side snapshot cost logic so the badge, histogram, filters, and hand mana total agree.
- Gem tags are display-formatted in the frontend. `GemConfig_YinYang` becomes `Yin Yang`, and mana modifier gems display as `Mana +N` / `Mana -N`.
- Open gem slots can be derived from the save: `Data.ProgressionSaveData.CardGemSlots[cardId] - GemIds.length`, clamped at zero. The app renders them as black/gold circles under the card's mana cost.
- Filled gem slots render generated gem sprites and should not show a separate colored backing ring.
- Evolved cards and base cards can differ. Do not fall back from an evolved `cardId` to `baseId` for cost unless you know it is correct.
- `Card_M_0_Wings` is a special wild-cost card even though the serialized cost map contains a numeric value.
- Game item ID-to-name mapping lives in `data/game-item-names.csv`. Card/gem rules text, optional rules tooltips, gold highlight tokens, and card color overrides live in the name-based `data/display-overrides.csv`. Regenerate local JSON and avoid editing generated JSON as the source of truth.
- The CSV display pipeline is split by builder: `build_card_text_map.py`, `build_gem_text_map.py`, and `build_text_meta.py` all consume `display-overrides.csv` through `tools/display_overrides.py`; name resolution comes from `game-item-names.csv`. `build_local_data.py` also passes the project display override CSV into those builders for user-triggered local rebuilds.
- Evolution recipes live in the name-based `data/evolutions.csv` and ship through `public/assets/evolutions.json`. The CSV uses `+` for required recipe parts and `|` for alternatives, and `tools/build_evolutions.py` resolves names through `data/game-item-names.csv`.
- Release prep must regenerate app-owned JSON from CSV before packaging: `tools/build_card_text_map.py`, `tools/build_gem_text_map.py`, `tools/build_text_meta.py`, and `tools/build_evolutions.py`.
- The evolution chart highlights owned components from the live deck snapshot. Normal first inputs require an open gem slot. Vandalier is special: Peachone and Ebony Wings both highlight if both are present and at least one has an open slot; if both are present but both are gemmed, both use the blocked/orange highlight. Phieraggi uses the same two-weapon rule for Eight The Sparrow and Phiera Der Tuphello; Tirajisú is presence-only.
- Blank gem text in `data/display-overrides.csv` intentionally hides that gem rule line while keeping the icon visible, currently including `GemConfig_DoubleDamage` and `GemConfig_Evolve`.
- The packaged app must include `public/assets/card-costs.json`, `public/assets/card-text.json`, `public/assets/evolutions.json`, `public/assets/gem-text.json`, `public/assets/text-meta.json`, and `resources/live-bridge/**`, but must not include extracted PNG art or generated `card-map.json`, `card-names.json`, or `gem-map.json`.
- App updates carry the live bridge payload. On the next launch, startup setup installs/updates it into the configured Steam game folder when the bundled payload differs. File > Install/Update Live Bridge remains as a manual fallback.

## Quick Sanity Checks

Use these after cost logic changes:

```powershell
node -c server.js
node -c src\main.js
node -c public\app.js
python -m py_compile tools\build_local_data.py tools\extract_art.py tools\build_card_map.py tools\build_card_cost_map.py tools\build_card_name_map.py tools\build_card_text_map.py tools\build_evolutions.py tools\build_gem_map.py tools\build_gem_text_map.py tools\build_text_meta.py tools\display_overrides.py
```

Check live save cost behavior:

```powershell
@'
const fs = require('fs');
const { getDeckSnapshot } = require('./server');
const costs = JSON.parse(fs.readFileSync('public/assets/card-costs.json', 'utf8'));
const snapshot = getDeckSnapshot(
  'C:\\Users\\justi\\AppData\\LocalLow\\Nosebleed Interactive\\Vampire Crawlers\\Save\\SaveProfile0.save',
  { cardCosts: costs }
);
for (const card of snapshot.cards) {
  if (/MagicWand|KingBible|NoFuture|Runetracer|WeightyTome/.test(card.cardId) || card.gems.some((gem) => /Mana|SetCostType_Wild/.test(gem))) {
    console.log(`${card.cardId} base=${card.baseCost} effective=${card.cost} gems=${card.gems.join(',') || '-'}`);
  }
}
console.log('costCounts', snapshot.costCounts.map((c) => `${c.cost}:${c.count}`).join(', '));
'@ | node -
```

Expected examples from prior testing:

```text
Card_A_1_MagicWand base=0 effective=-1 gems=GemConfig_Mana_Minus1
Card_A_1_KingBible base=1 effective=3 gems=GemConfig_Mana_Plus2
Card_A_3_NoFuture base=3 effective=3 gems=GemConfig_Evolve
Card_B_2_EmptyTome base=2 effective=W gems=GemConfig_SetCostType_Wild
```

## Good Next Tasks

- Add a small diagnostic export/log button.
- Use the current dry-run `play-card` command result to identify the real in-game play-card method before enabling any mutating bridge command.
- Add tests for mana gem parsing, card cost lookup, open gem slot display, startup setup, and evolution availability.
- Consider a visible "waiting for live game data" status when the bridge is installed but no fresh live-state JSON has been emitted yet.
- The BepInEx IL2CPP live bridge is implemented. Release prep should run `npm run stage-live-bridge`; use `python tools\stage_live_bridge_payload.py --with-bepinex` when a self-contained BepInEx loader payload should be included.
