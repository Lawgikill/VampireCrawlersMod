# Codex Handoff

This project is a read-only second-screen deck tracker for the Unity game **Vampire Crawlers**. The user wants to improve the in-game deck visibility without editing saves, patching game files, injecting into the process, or requiring other players to do technical setup.

The current app reads the active save file, extracts the card piles already serialized by the game, maps cards to extracted local art, and displays a sortable compact deck view in Electron.

## Current State

- Version is currently `0.1.1`.
- The app has both browser mode and Electron desktop mode.
- Browser mode:
  - `npm start`
  - opens `http://127.0.0.1:5177`
- Desktop dev mode:
  - `npm run desktop`
- Release build:
  - `npm run build-asset-builder`
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
art\*.png
```

## High-Level Flow

1. `src/main.js` starts Electron and launches the local HTTP server from `server.js`.
2. `src/config.js` auto-detects game install and save file.
3. `server.js` reads the save file on each `/api/deck` request.
4. `public/app.js` polls `/api/deck` every two seconds.
5. Art is displayed from a generated local `card-map.json`.
6. Cost data comes from `card-costs.json`.
7. `Rebuild Local Data` runs a bundled helper exe in packaged builds.

## Things That Are Known Fragile

- The save file polling is only as real-time as the game’s save writes. It is not process-memory live.
- The card art mapping is reverse-engineered from Unity assets and is not perfect for every future card/config.
- Unity/Odin serialized `CardConfig` data is partially custom; do not assume `read_typetree()` will expose all fields.
- Card IDs like `Card_A_1_MagicWand` are not reliable for mana cost. MagicWand’s true base cost is `0`.
- Evolved cards and base cards can differ. Do not fall back from an evolved `cardId` to `baseId` for cost unless you know it is correct.
- The packaged app must include `public/assets/card-costs.json` but must not include extracted PNG art or generated `card-map.json`.

## Quick Sanity Checks

Use these after cost logic changes:

```powershell
node -c server.js
node -c src\main.js
python -m py_compile tools\build_local_data.py tools\extract_art.py tools\build_card_map.py tools\build_card_cost_map.py
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
  if (/MagicWand|KingBible|NoFuture|Runetracer/.test(card.cardId) || card.gems.some((gem) => /Mana/.test(gem))) {
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
```

## Good Next Tasks

- Improve the setup UI so it explains what `Rebuild Local Data` is doing.
- Add a first-run friendly flow that automatically triggers local data rebuild if art is missing.
- Add a small diagnostic export/log button.
- Add tests for mana gem parsing and card cost lookup.
- Consider BepInEx IL2CPP plugin only if save polling proves insufficient.
