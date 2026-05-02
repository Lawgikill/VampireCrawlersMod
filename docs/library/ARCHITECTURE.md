# Architecture Notes

## Runtime Components

### Electron Main Process

File: `src/main.js`

Responsibilities:

- Creates the desktop window.
- Loads/saves config using `src/config.js`.
- Starts the local HTTP server from `server.js` on a random port in desktop mode.
- Provides the `run-startup-setup` IPC handler used by the renderer's blocking first-run/update setup modal.
- Provides the `rebuild-art-cache` IPC handler used by the renderer's **Rebuild Local Data** button.
- Automatically installs/updates the packaged live-bridge payload during startup setup when the configured game folder is known.
- Provides the File > Install/Update Live Bridge action as a manual fallback.
- Runs either the bundled local data helper or a Python fallback.

Important functions:

- `buildMenu()`
- `runProcess()`
- `runPython()`
- `getAssetBuilderPath()`
- `runLocalDataBuilder()`
- `runStartupSetup()`
- `installOrUpdateLiveBridge()`
- IPC handlers: `run-startup-setup`, `rebuild-art-cache`

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

During startup setup, the renderer opens a blocking progress modal and asks the
main process to verify local readiness. The main process prompts only if the
game install folder or save file cannot be detected. If generated local data is
missing or any mapped card/gem art file is missing, setup runs the bundled asset
builder automatically. If the live bridge payload differs from the game folder,
setup copies the payload automatically. `File > Install/Update Live Bridge`
remains as a manual fallback.

The live bridge also draws a tiny two-line in-game overlay near the lower right
combat UI area showing `HAND MANA` and `TOTAL: <value>`. The first IMGUI
attempt could draw text but could not reliably draw an opaque panel in this
IL2CPP runtime: `GUI.DrawTexture` threw `NotSupportedException`, and style
backgrounds on `GUI.Label`/`GUI.Box` were not visible in-game. The working
implementation now uses a real `ScreenSpaceOverlay` Unity UI `Canvas` with an
opaque `Image` panel and a `Text` child. The panel is styled and positioned to
line up near the game's **End Turn** button. This is intentionally narrow in
scope: the Electron app remains the main tracker UI, while the plugin provides
only a few high-value in-game hints.

The bridge also has an experimental command channel for future app-to-game
control work. The app/server writes:

```text
%APPDATA%\VampireCrawlersDeckTracker\command.json
```

The bridge polls this file and writes command results to:

```text
%APPDATA%\VampireCrawlersDeckTracker\command-result.json
```

`play-card` commands now perform real game actions. The frontend sends a
`play-card` command for the clicked hand card, the bridge matches the live
`CardModel` by GUID, and the bridge invokes the game's own
`CardModel.TryPlayCard()` method. The result file records the invoked method,
return value, and any invocation error. A `dryRun` flag remains available for
diagnostic commands.

### Config

File: `src/config.js`

Responsibilities:

- Detect default Steam install.
- Detect default save file.
- Store config under `%APPDATA%\VampireCrawlersDeckTracker\config.json`.
- Define `generatedDir`, currently `%APPDATA%\VampireCrawlersDeckTracker\generated`.
- Store `hideSetupPanel`, which hides the Local setup panel by default after the user confirms **Hide Forever**.

The app allows choosing the game install and save file from the File menu. The
File menu also exposes **Rebuild Local Data** for rebuilding extracted local art,
card cost data, card art mappings, and display names even if the Local setup
panel is hidden. Server requests read the current config object, so saved path
changes are reflected without restarting the local server.

The Help menu exposes **Report Bug**, which opens a native dialog directing
users to report bugs, issues, or questions to `@Lawgikill` on Discord.

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
  - `/api/live-command`
  - `/api/live-command-result`
- Parse save file piles into normalized card data.
- Apply cost data and mana modifiers.

Important behavior:

- `/api/deck` reloads `card-costs.json` on every request. That makes cost-data rebuilds visible without restarting.
- Card art, display names, and gem art are served from the generated assets directory with `public/assets` fallbacks for local development.
- Card text, gem text, and display metadata are app-owned assets served from `public/assets` first so app updates can refresh wording, highlights, and card colors without requiring users to rebuild local data.
- Static path resolution checks `public` first, then generated assets for `/assets/...`.
- Generated assets fill in `/assets/...` paths that are not shipped in `public/`; `public` is checked first.
- `/api/live-command` accepts experimental bridge commands and writes the command file consumed by the BepInEx plugin.
- `/api/live-command-result` reads the most recent bridge command result, including the invoked game method and any invocation error for `play-card`.

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
- Filter by cost bucket, switch between all cards and cards in hand, and sort the visible card grid.
- The Costs/Frequency sidebar can be collapsed from the top toolbar with
  **Hide Column** / **Show Column**. This is UI-only session state; cost filters
  and frequency sort state remain intact while the sidebar is hidden.
- The card grid header shows `CURRENT MANA`, `HAND MANA TOTAL`, and live pile
  counts for `DRAW PILE`, `DISCARD PILE`, and `COMBO PILE` from
  `snapshot.piles[].count`.
- The card grid has action filters for:
  - only showing cards that continue combo,
  - hiding cards about to break (`shatter 2`),
  - always showing Attractorb through those two action filters.
  Wild-cost cards (`cost === "W"`) are always treated as combo continuers even
  if the bridge does not mark their cost text with the combo highlight.
- Render generated card rules text and gem rules text inside the card description plate.
- Render the evolution cheat sheet modal from `public/assets/evolutions.json`.
- In live-bridge mode, cards in hand are clickable. Clicking a hand card sends a real `play-card` command to the bridge. The app keeps success quiet, surfaces errors in the toolbar, polls the command result until the matching command ID is observed so stale results do not leave the UI latched, and immediately refreshes `/api/deck` after bridge confirmation so played cards leave the hand view without waiting for the normal two-second poll.
- In live-bridge mode, the app also displays `CURRENT MANA` from the bridge's promoted `CurrentMana` field. The bridge obtains this from the visible mana orb text at `_manaDisplay oldschool (plinth)/oldschool (angel)/ManaOrb/_manaFiller/_manaCountText`, not from `PlayerModel.CachedMana`, which was observed to report stale or zero values.
- Combo mana-cost highlighting is latched in the frontend until the unique set
  of cards in hand changes. This smooths over the game's cost-text flicker while
  still clearing naturally when cards are played or drawn.
- Cracked/shattered overlays are combat-local learned state keyed by card GUID
  when available. During combat, an observed shatter state can only promote
  `none -> shatter 1 -> shatter 2`; missing/flickered bridge fields do not
  downgrade it, and moving into deck/draw/discard does not clear it. When
  `snapshot.isInCombat === false`, learned shatter state is cleared and overlays
  are suppressed for out-of-combat snapshots.

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
  "IsBroken": false,
  "CardCrackStage": 0,
  "BreakableCrackState": "Cracked",
  "BreakableCrackStage": 0,
  "BreakableTimesPlayedThisTurn": 3,
  "CardCrackSprite": "shatter 1"
}
```

`IsBroken` and `CardCrackStage` are distinct. `IsBroken` is a gameplay/model
flag. `CardCrackStage` is intended to capture model-owned cracked/shattered
state when available. Live testing showed the visible crack can still be absent
from `CardModel`, so the bridge inspects the matching
`Nosebleed.Pancake.View.CardView` when present. For normal cards, the visible
crack/shatter state has been observed on
`Nosebleed.Pancake.GameLogic.BreakableCard`; the bridge promotes
`BreakableCrackState`, `BreakableCrackStage`,
`BreakableTimesPlayedThisTurn`, and `CardCrackSprite` into first-class live
card fields. Raw card-view diagnostics are now gated behind
`EnableVerboseDiagnostics` in `LiveBridgeBehaviour` because shipping them every
bridge tick made the game slightly jittery.

## Cost Logic

Cost logic lives in `server.js`:

- `getCardCost(cardId, baseId, cardCosts)`
- `getGemManaModifier(gems)`
- `getEffectiveCardCost(baseCost, card)`

Rules:

- Use `cardCosts[cardId]` first.
- Only use `baseId` if `cardId === baseId`.
- `FCC_*` cards use `RunMetaSaveData.SelectedPartyFccIds`: the first selected crawler costs `0`, other selected crawlers cost `1`.
- Cost distribution buckets keep crawlers separate from normal mana costs. The frontend renders `Wild` plus normal mana buckets as a compact histogram, while `Crawler N` buckets stay as rows.
- `GemConfig_SetCostType_Wild` changes the card's effective cost to `W` before numeric mana modifiers are applied.
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

Game ID-to-name mapping lives in:

```text
data/game-item-names.csv
```

`game-item-names.csv` is the mapping layer with `kind,id,name`. It can contain
multiple IDs for the same display name. `display-overrides.csv` is the
human-edited, deduplicated name sheet with:

```text
name,game_text,text,tooltip,gold,color
```

The text builders expand `name` back to matching game IDs through
`game-item-names.csv`. `game_text` is comparison/reference text from the current
game-data decoder; `text` is the app override source of truth. Blank `text`
means intentionally show no rules text. Blank `gold` means no gold-highlighted
terms. The frontend display metadata is built from `gold` and `color`, using
pipe-separated highlight tokens such as `XX|Crit` or `Area|XX%`. For card rows,
`tooltip` is optional helper copy shown when hovering over the rendered card
rules text; keep multiple helper entries pipe-separated in the CSV if needed.
Literal `\n` sequences are also converted to real line breaks by the CSV loader.
`color` overrides the frontend card color/type class. Supported values are
`attack`, `support`, `buff`, `utility`, `crawler`, `defence`, and `unknown`;
aliases such as `red`, `yellow`, `purple`, `green`, `blue`, and `gray` are also
accepted by the frontend. Do not add per-card or per-gem override dictionaries
back into the Python builders.

CSV-to-display ownership is:

- `tools/build_card_text_map.py` reads `data/display-overrides.csv` for card text overrides.
- `tools/build_gem_text_map.py` reads `data/display-overrides.csv` for gem text overrides.
- `tools/build_text_meta.py` reads `data/display-overrides.csv` for highlights, tooltips, and colors.
- All three expand display names through `data/game-item-names.csv` using `tools/display_overrides.py`.
- `tools/build_evolutions.py` reads `data/evolutions.csv` and resolves names through `data/game-item-names.csv`.
- `tools/build_local_data.py` passes the project `data/display-overrides.csv` into the local card/gem text and metadata builders when users rebuild local data from the app.

Audit note, 2026-05-02: all editable CSV display sources are wired into app
display generation. `data/display-overrides.csv` feeds card text, gem text,
highlight metadata, hover tooltips, and color metadata through
`tools/display_overrides.py`; `data/game-item-names.csv` resolves display names
back to card/gem IDs for those builders and for evolutions; `data/evolutions.csv`
feeds `public/assets/evolutions.json`. `tools/build_local_data.py` also passes
the project display override CSV into the user-triggered local rebuild pipeline.
The release build must regenerate `card-text.json`, `gem-text.json`,
`text-meta.json`, and `evolutions.json` before packaging so CSV changes are
reflected in the app.

The frontend highlights rule placeholders and selected keywords such as `XX`,
`XX%`, `Crit`, `Disarm`, `Duration`, `Area`, `Crawler`, and `Might` in gold. `Wings` is a
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

## Evolution Cheat Sheet

Evolution reference data starts in:

```text
data/evolutions.csv
```

The app consumes:

```text
public/assets/evolutions.json
```

The CSV is name-based with:

```text
input_names,result_name,source_note
```

It uses `+` for required recipe parts and `|` for alternatives inside a part.
For example:

```text
Magic Wand + Empty Tome|Light Tome|Weighty Tome|Ancient Tome,Holy Wand,PDF best-match
```

means Magic Wand plus any listed Tome variant evolves into Holy Wand.
`tools/build_evolutions.py` expands those names back to representative card IDs
through `data/game-item-names.csv` and writes `public/assets/evolutions.json`.
The frontend renders this as a visual recipe modal using existing card art from
`card-map.json` and display names from `card-names.json`. Keep the CSV
human-editable and regenerate/update the JSON whenever recipes are changed.

The evolution chart also highlights components and already-owned results from the current deck snapshot.
For normal evolutions, the first input is the evolving attack card and only
counts as available if a matching card has an open gem slot for the Evolve gem.
Later inputs count as available when present. `Card_A_5_Vandalier` is a special
two-weapon union: if Peachone and Ebony Wings are both present and at least one
has an open gem slot, both highlight as available; if both are present but both
are gemmed, both highlight in the blocked/orange state. `Card_A_4_Phieraggi`
uses the same two-weapon rule for Eight The Sparrow and Phiera Der Tuphello;
Tirajisú is a normal presence-only input.

The main deck grid uses the same evolution availability rules to show a small
gold marker on card title bars. A standard single marker means the card is a
usable evolution component; the paired marker means it belongs to a recipe where
all required components are currently available.

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
public/assets/evolutions.json
public/assets/gem-text.json
public/assets/text-meta.json
resources/live-bridge/**
```

Reason:

- Extracted art should not ship.
- Card cost data is tiny and needed as a fallback before users rebuild local data.
- Card/gem rules text and display metadata are app-authored data and should update with the app.
- Evolution data is app-authored reference data and should update with the app.
- The live bridge payload is release-owned data and should update with the app.

The packaged helper is included via `extraResources` from:

```text
bin\vampire-crawlers-asset-builder.exe
```

to:

```text
resources\asset-builder\vampire-crawlers-asset-builder.exe
```

