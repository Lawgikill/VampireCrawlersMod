# Architecture Notes

## Runtime Components

### Electron Main Process

File: `src/main.js`

Responsibilities:

- Creates the desktop window.
- Loads/saves config using `src/config.js`.
- Starts the local HTTP server from `server.js` on a random port in desktop mode.
- Provides the `rebuild-art-cache` IPC handler used by the renderer's **Rebuild Local Data** button.
- Silently installs/updates the packaged live-bridge payload into the configured game folder on app startup and after game folder selection.
- Provides the File > Install/Update Live Bridge action as a manual fallback.
- Runs either the bundled local data helper or a Python fallback.

Important functions:

- `buildMenu()`
- `runProcess()`
- `runPython()`
- `getAssetBuilderPath()`
- `runLocalDataBuilder()`
- `installOrUpdateLiveBridge()`
- IPC handler: `rebuild-art-cache`

The bundled helper is expected at one of:

```text
bin\vampire-crawlers-asset-builder.exe
resources\asset-builder\vampire-crawlers-asset-builder.exe
resources\app\bin\vampire-crawlers-asset-builder.exe
```

The `resources\asset-builder` path is the important packaged path from `extraResources`.

The live bridge payload is expected at one of:

```text
resources\live-bridge\
resources\app\resources\live-bridge\
```

Packaged releases place it at:

```text
resources\live-bridge\
```

On startup, and after a user chooses a game folder, the app silently copies that
payload into the configured Vampire Crawlers game folder. This means an app
update can carry a new bridge/BepInEx payload and the next app launch will
install/update it in the Steam game directory. `File > Install/Update Live
Bridge` remains as a manual fallback.

### Config

File: `src/config.js`

Responsibilities:

- Detect default Steam install.
- Detect default save file.
- Store config under `%APPDATA%\VampireCrawlersDeckTracker\config.json`.
- Define `generatedDir`, currently `%APPDATA%\VampireCrawlersDeckTracker\generated`.
- Store `hideSetupPanel`, which hides the Local setup panel by default after the user confirms **Hide Forever**.

The app allows choosing the game install and save file from the File menu. The File menu also exposes **Rebuild Local Data** for rebuilding extracted local art, card cost data, card art mappings, and display names even if the Local setup panel is hidden. Changes are saved, but the current implementation does not restart the server automatically after changing paths.

### HTTP Server

File: `server.js`

Responsibilities:

- Serve `public/`.
- Serve generated assets from the per-user generated dir.
- Provide JSON APIs:
  - `/api/deck`
  - `/api/config`
  - `/api/art`
  - `/api/card-map`
  - `/api/card-names`
  - `/api/card-text`
  - `/api/gem-map`
  - `/api/gem-text`
  - `/api/text-meta`
- Parse save file piles into normalized card data.
- Apply cost data and mana modifiers.

Important behavior:

- `/api/deck` reloads `card-costs.json` on every request. That makes cost-data rebuilds visible without restarting.
- Card art, display names, and gem art are served from the generated assets directory with `public/assets` fallbacks for local development.
- Card text, gem text, and display metadata are app-owned assets served from `public/assets` first so app updates can refresh wording, highlights, and card colors without requiring users to rebuild local data.
- Static path resolution checks `public` first, then generated assets for `/assets/...`.
- Generated assets fill in `/assets/...` paths that are not shipped in `public/`; `public` is checked first.

### Frontend

Files:

- `public/index.html`
- `public/app.js`
- `public/styles.css`

Responsibilities:

- Poll `/api/deck` every two seconds.
- Poll `/api/config` every ten seconds.
- Load `/api/card-map`, `/api/card-names`, `/api/card-text`, `/api/gem-map`, `/api/gem-text`, and `/api/text-meta` once on startup and after local data rebuild.
- Render the cost curve, non-mana cost buckets, card frequency, and card grid.
- Search/filter/sort.
- Render generated card rules text and gem rules text inside the card description plate.

Current default sort:

1. cost
2. card ID
3. save index

This appears in `public/app.js` as `state.sortBy = "cost"` and `sortCards()`.

The Frequency section defaults to card-name sorting. Users can switch that
section between:

- card name
- count, descending, with card-name tie-break

## Save Parsing

The server recursively walks the full save JSON and looks for objects shaped like:

```json
{
  "cardPileId": "DrawPile",
  "cards": []
}
```

Known piles:

- `HandPile`
- `DrawPile`
- `DiscardPile`
- `ComboPile`
- `FccPile`
- `ThrowingPile`

The code intentionally accepts any `cardPileId` rather than hard-coding only these names.

Each save card can include:

```json
{
  "CardConfigId": "Card_A_1_KingBible",
  "BaseCardConfigId": "Card_A_1_KingBible",
  "CardGuid": "...",
  "ManaCostModifier": 0,
  "TempManaCostModifier": 0,
  "ConfusedManaCostModifier": 0,
  "GemIds": ["GemConfig_Mana_Plus2"],
  "IsTemporary": false,
  "IsBroken": false
}
```

## Cost Logic

Cost logic lives in `server.js`:

- `getCardCost(cardId, baseId, cardCosts)`
- `getGemManaModifier(gems)`
- `getEffectiveCardCost(baseCost, card)`

Rules:

- Use `cardCosts[cardId]` first.
- Only use `baseId` if `cardId === baseId`.
- `FCC_*` cards use `RunMetaSaveData.SelectedPartyFccIds`: the first selected crawler costs `0`, other selected crawlers cost `1`.
- Cost distribution buckets keep crawlers separate from normal mana costs. The frontend renders normal mana buckets as a compact histogram, while `Wild` and `Crawler N` buckets stay as rows.
- `Card_W_*` and `Card_E_*` cards are displayed with wild cost `W`.
- `Card_M_0_Wings` is also displayed with wild cost `W`; the serialized cost map contains a numeric value, but the in-game card uses the wild marker.
- Unknown costs remain `Unknown`.
- Mana gems parse as:
  - `GemConfig_Mana_Plus2`
  - `GemConfig_ManaPlus2`
  - `GemConfig_Mana_Minus3`
  - `GemConfig_ManaMinus3`
- Costs can be negative. Never clamp to zero.

Open gem slots are not stored on each card instance. Card instances only store
filled `GemIds`; unlocked slot capacity comes from
`Data.ProgressionSaveData.CardGemSlots`, keyed by card config ID. Display open
slots as `CardGemSlots[cardId] - GemIds.length`, clamped at zero. The frontend
renders each open slot as a black circle with a gold outline under the mana cost
badge. Filled slots use generated gem art from `gem-map.json`; they should not
show a separate blue backing ring.

Why not fallback from evolved `cardId` to `baseId`?

Because `Card_A_3_NoFuture` can have `BaseCardConfigId: Card_A_1_Runetracer`, but NoFuture's real cost is `3`, not Runetracer's `1`.

## Art Logic

Generated art is extracted by `tools/extract_art.py` to:

```text
assets/art/*.png
assets/art-manifest.json
```

Card-to-art mapping is generated by `tools/build_card_map.py`:

```text
assets/card-map.json
```

Some newer `FCC_*` crawler configs, such as `FCC_Antonio`, exist outside the
older global card-group wiring and can have no group ref. The map builder falls
back to matching crawler IDs to extracted sprite names such as `newAntonio_01`
or `Antonio_01`.

The frontend resolves:

```js
state.cardMap[card.cardId] || state.cardMap[card.baseId] || ""
```

This fallback is currently acceptable for art because evolved/base art mapping is a presentation problem, not core cost correctness.

Card display names are generated by `tools/build_card_name_map.py`:

```text
assets/card-names.json
```

The builder reads the game's English Unity localization tables and pairs embedded
card-config localization IDs with card IDs. This is required for cards where the
serialized ID suffix is not the displayed name, such as `Card_S_2_Spinach`
rendering as `Sprig o' Spinach`.

Card rules text is generated by `tools/build_card_text_map.py`:

```text
assets/card-text.json
```

This mapper combines Unity localization references with targeted raw/Odin effect
decoding. Some entries have explicit overrides because the in-game phrasing is
shorter or more specific than the best mechanically generated text. Examples:

- `Card_A_0_Garlic`: `Deal XX damage to the front row.\nDisarm.`
- `Card_M_0_Wings`: `Reduce Mana cost of next card played by 1.`
- `Card_S_2_Spinach`: `Might : Deal XX% more damage.`

Manual card/gem display overrides live in:

```text
data/display-overrides.csv
```

This CSV is a full editable mapping sheet with:

```text
kind,id,name,text,gold,color
```

The text builders consume `kind`, `id`, and `text`; `name` is there so humans
can find rows without memorizing IDs. The frontend display metadata is built
from `gold` and `color`, using pipe-separated highlight tokens such as `XX|Crit` or `Area|XX%`. For
every row in this CSV, `text` is the source of truth. Blank `text` means
intentionally show no rules text. Blank `gold` means no gold-highlighted terms.
For card rows, `color` overrides the frontend card color/type class. Supported
values are `attack`, `support`, `buff`, `utility`, `crawler`, `defence`, and
`unknown`; aliases such as `red`, `yellow`, `purple`, `green`, `blue`, and
`gray` are also accepted by the frontend. Do not add per-card or per-gem
override dictionaries back into the Python builders.

The frontend highlights rule placeholders and selected keywords such as `XX`,
`XX%`, `Crit`, `Disarm`, `Duration`, `Area`, and `Might` in gold. `Wings` is a
special case: its literal `1` stays white.

Gem art is generated by `tools/build_gem_map.py`:

```text
assets/gem-map.json
```

Gem rules text is generated by `tools/build_gem_text_map.py`:

```text
assets/gem-text.json
```

Gem text is intentionally concise and sometimes overridden through
`data/display-overrides.csv` to match observed in-game wording.
`GemConfig_Armor` decodes `_armorAmount` and currently renders as
`Add 2 Armor.` with only the numeric value highlighted in gold. Some gem rules
are intentionally blank in `data/display-overrides.csv` while their icons remain
visible, including `GemConfig_DoubleDamage` and `GemConfig_Evolve`.

## Packaging

Electron build config is in `package.json`.

The build intentionally excludes generated, user-local art and mapping data:

```json
"!public/assets/art/**",
"!public/assets/art-manifest.json",
"!public/assets/card-map.json",
"!public/assets/card-names.json",
"!public/assets/gem-map.json",
"!public/assets/contact-sheet-*.png"
```

It intentionally includes:

```text
public/assets/card-costs.json
public/assets/card-text.json
public/assets/gem-text.json
public/assets/text-meta.json
resources/live-bridge/**
```

Reason:

- Extracted art should not ship.
- Card cost data is tiny and needed as a fallback before users rebuild local data.
- Card/gem rules text and display metadata are app-authored data and should update with the app.
- The live bridge payload is release-owned data and should update with the app.

The packaged helper is included via `extraResources` from:

```text
bin\vampire-crawlers-asset-builder.exe
```

to:

```text
resources\asset-builder\vampire-crawlers-asset-builder.exe
```

