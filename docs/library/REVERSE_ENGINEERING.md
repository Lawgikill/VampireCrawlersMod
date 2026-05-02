# Reverse Engineering Notes

These notes capture the Vampire Crawlers Unity/Odin serialization findings that matter for this tracker.

## Tooling Used

- `UnityPy` for reading Unity assets and sprites.
- `AssetRipper` as a temporary inspection aid.
- Raw byte parsing for `CardConfig` data that UnityPy/AssetRipper do not expose through typetrees.

The game is an IL2CPP Unity game. Script metadata can be inspected in:

```text
Vampire Crawlers_Data\il2cpp_data\Metadata\global-metadata.dat
```

Important discovered `CardConfig` fields from metadata:

- `GetManaCost`
- `manaCost`
- `_manaCosts`
- `_manaCostStyle`
- `ManaCostStyle`
- `CardCostType`
- `_cardCostType`
- `_baseSlotCost`

## Key Lesson

Do **not** infer mana cost from the card ID.

Example:

```text
Card_A_1_MagicWand
```

The middle `1` looks like a mana cost but is not reliable. The actual serialized `CardConfig` says MagicWand base cost is `0`.

Known verified examples:

```text
Card_A_1_MagicWand => 0
Card_A_1_KingBible => 1
Card_A_3_NoFuture => 3
Card_S_2_Bracer => 0
Card_S_2_Spinach => 2
```

## CardConfig Serialization

Many `CardConfig` objects are `MonoBehaviour` objects whose useful data is partly in a custom/Odin serialized chunk plus a Unity tail.

UnityPy `read_typetree()` is not enough for these stripped/custom objects.

The raw object begins with Unity fields including:

- script pointer at offset `20`
- `m_Name` length at offset `28`
- `m_Name` bytes at offset `32`

The tail start used by the current tools is:

```python
def align(value, boundary):
    return (value + boundary - 1) // boundary * boundary

def get_tail_start(raw):
    name_length = struct.unpack_from("<I", raw, 28)[0]
    odin_length_offset = align(32 + name_length, 4) + 4
    odin_length = struct.unpack_from("<I", raw, odin_length_offset)[0]
    return align(odin_length_offset + 4 + odin_length, 4)
```

In the tail, `CardConfig` serializes:

1. card type pointer
2. card group pointer
3. `_manaCostStyle`
4. `manaCost`
5. `_manaCosts`

The current cost parser finds the first relevant card-group pointer and reads mana fields immediately after it:

```text
mana_offset = group_ref_offset + 12
mana_style = int32 at mana_offset
single_cost = int32 at mana_offset + 4
cost_count = int32 at mana_offset + 8
costs = int32 list after that
```

`ManaCostStyle`:

```text
0 = Single
1 = Multiple
```

For `Multiple`, the current mapper stores the first list cost. This worked for known cases in the tracker, but if future gameplay needs level-dependent cost display, revisit this.

## Global Versus Shared Assets

Base cards are mostly in:

```text
globalgamemanagers.assets
```

Some evolved or extra cards are in:

```text
sharedassets0.assets
resources.assets
sharedassets*.assets
```

For cost mapping:

- `build_card_cost_map.py` scans `globalgamemanagers.assets`, `resources.assets`, and `sharedassets*.assets`.
- It resolves `CardConfig` and `CardGroup` scripts from `globalgamemanagers.assets`.
- It detects local `CardGroup` objects in each scanned asset file too.
- It handles file IDs loosely because shared assets can reference global groups with `file_id == 1`.

For art mapping:

- `build_card_map.py` scans `globalgamemanagers.assets`, `resources.assets`, and `sharedassets*.assets`.
- It resolves `CardConfig` and `FccConfig` objects, then maps them through `CardGroup` sprite refs.
- It also detects local `CardGroup` objects in shared asset files; this matters for event cards such as `Card_E_LittleClover` and `Card_E_Orologion`.
- FCC cards without group refs can fall back to character sprite names such as `newAntonio_01`.

## FCC Crawler Costs

Do not read crawler costs from the `FCCConfig` Odin `_cardCostType` payload. The
nearby `5` byte is serializer/type metadata, not mana cost.

The visible crawler cost appears to be runtime party-position logic from the
save's `RunMetaSaveData.SelectedPartyFccIds`:

```text
selected party index 0 -> cost 0
other selected FCC cards -> cost 1
```

This matches observed game screenshots where `FCC_Imelda` is first in the
selected party and costs `0`, while `FCC_Antonio` costs `1`.

## MagicWand Investigation

Raw findings from earlier debugging:

```text
MonoBehaviour path 8270
m_Name = Card_A_0_MagicWand
AssetId string in tail = Card_A_1_MagicWand
```

This mismatch is why trusting IDs was dangerous.

Live save example:

```json
{
  "CardConfigId": "Card_A_1_MagicWand",
  "BaseCardConfigId": "Card_A_1_MagicWand",
  "ManaCostModifier": 0,
  "TempManaCostModifier": 0,
  "ConfusedManaCostModifier": 0,
  "GemIds": ["GemConfig_Mana_Minus1"]
}
```

Correct result:

```text
base=0 effective=-1
```

Costs can go negative in this game.

## NoFuture Investigation

Live save example:

```json
{
  "CardConfigId": "Card_A_3_NoFuture",
  "BaseCardConfigId": "Card_A_1_Runetracer",
  "GemIds": ["GemConfig_Evolve"]
}
```

Correct result:

```text
base=3 effective=3
```

This is why `server.js` does not use `baseId` as a general fallback for cost. If `cardCosts[cardId]` is missing, showing `Unknown` is better than silently showing the base card's wrong cost.

## Mana Gems

Save gem IDs seen:

```text
GemConfig_Mana_Plus1
GemConfig_Mana_Plus2
GemConfig_Mana_Minus1
```

The current parser supports:

```text
GemConfig_Mana_Plus<n>
GemConfig_ManaPlus<n>
GemConfig_Mana_Minus<n>
GemConfig_ManaMinus<n>
```

Semantics:

```text
Plus<n> adds n to cost.
Minus<n> subtracts n from cost.
```

This is intentionally not clamped.

## Wild Cost Gem

`GemConfig_SetCostType_Wild` changes the card's effective cost type to `W`.
Handle this before applying numeric mana modifiers. This is runtime deck-state
logic, not a visual-only frontend rule, because the cost badge, cost histogram,
cost filtering, and hand mana total all consume the normalized server snapshot.

## Gem Slots

The save stores open gem-slot capacity separately from occupied gems.

Per-card instances in piles contain occupied gems only:

```json
"GemIds": []
```

Unlocked slot counts live in:

```text
Data.ProgressionSaveData.CardGemSlots
```

This is a key/value list keyed by card config ID. In the observed save:

```text
Card_A_0_Whip => 1
Card_A_1_Runetracer => 1
Card_D_0_Armor => 0
Card_B_2_EmptyTome => 2
```

To render open gem slots for a card, use:

```text
open slots = CardGemSlots[cardId] - GemIds.length
```

Clamp at zero for display. `GemIds.length` is the count of filled slots on that
specific card instance, while `CardGemSlots[cardId]` appears to be the unlocked
slot capacity for that card config. The tracker shows open slots as black/gold
circles under the mana cost badge.

## Live Card State

The live bridge reads runtime `CardModel` objects when available. Known exported
state fields include:

```text
IsBroken
IsCopyWithDestroy
TimesLimitBroken
CardCrackStage
```

`IsBroken` did not reflect the observed cracked/shattered card face in a live
test. Game strings and app code point to a separate crack pipeline, including
names such as `CrackCardCommand`, `CrackCardAnimation`, `CardCrackingConfig`,
and `_cardCrackRenderer`. The bridge therefore exports `CardCrackStage`
separately via reflection fallbacks:

```text
CardCrackStage
CrackStage
_cardCrackStage
_crackStage
cardCrackStage
crackStage
CardCrackingConfig.Stage
_cardCrackingConfig.Stage
CrackingConfig.Stage
_crackingConfig.Stage
```

If cracked/shattered cards still report stage `0`, inspect card view/controller
objects rather than only `CardModel`; the crack renderer may be view-owned.
The bridge builds a GUID-keyed map from `Nosebleed.Pancake.View.CardView`
instances to their owned `CardModel`, then promotes the useful visual fields
onto each live card. Raw `CardViewDiagnostics` and `CardViewComponents` are now
behind `EnableVerboseDiagnostics` in `LiveBridgeBehaviour`; leave that flag off
for releases because broad reflection and large JSON payloads caused slight
game jitter.

Live testing on a visibly cracked combo-pile Spellbinder showed that
`CardModel` still reported `IsBroken = false`, `TimesLimitBroken = 0`, and
`CardCrackStage = 0`. The useful state was attached to the card view as:

```text
Nosebleed.Pancake.GameLogic.BreakableCard
BreakableCard.CrackState = Cracked
BreakableCard._cardCrackState = Cracked
BreakableCard.TimesPlayedThisTurn = 3
BreakableCard.CardCrackStage = 0
_cardCrackRenderer enabled = true
CardCrack sprite = shatter 1
```

The bridge promotes the stable parts of this probe into live card fields:

```text
BreakableCrackState
BreakableCrackStage
BreakableTimesPlayedThisTurn
CardCrackSprite
```

Treat `BreakableCrackState` as the primary signal for visible crack state unless
future tests show a separate value for full shatter.

The frontend treats crack/shatter data as combat-local learned state. Once a
bridge capture shows `shatter 1` or `shatter 2` for a card, the app remembers
the highest observed shatter state for that card GUID until combat ends. Missing
fields in later captures do not clear or downgrade the state because the game
often stops exposing view-owned crack data when the card is no longer being
inspected in hand/combo. The only normal reset is `isInCombat === false`, which
clears all learned shatter state and suppresses out-of-combat crack overlays.

## Current Mana

The reliable current-mana source is the visible blue mana orb text, not the
player model cache. `PlayerModel.CachedMana` was observed reporting `0` while
the in-game orb showed `4`.

The bridge reads:

```text
Player/Canvas/ShakeContainer/_manaDisplay oldschool (plinth)/oldschool (angel)/ManaOrb/_manaFiller/_manaCountText
```

and exports that value as `DisplayedMana` and `CurrentMana`. The bridge caches
the text component after discovery so normal captures only read the text value.

## Combo Highlight State

The direct combo candidate signal is the card view cost text containing the
orange-glow material markup, for example:

```text
<font="MainFont" material="MainFont Material Orange Glow">1</font>
```

The bridge exports this as `IsComboCostHighlighted` and `ComboCostText`.
Because the game can flicker that text state between captures, the frontend
latches combo mana-cost highlighting until the unique set of hand cards changes.
Wild-cost cards are a frontend-defined exception for action filtering: cards
whose normalized cost is `W` are always considered combo continuers, even if the
bridge does not currently mark their cost text as highlighted.

## Experimental Play-Card Bridge

The app-to-game command channel is now confirmed for real card play. `play-card`
commands are written by the Node server to
`%APPDATA%\VampireCrawlersDeckTracker\command.json`, then consumed by the
BepInEx bridge. The bridge matches a hand card by GUID, hand index, or card ID,
then invokes:

```text
Nosebleed.Pancake.Models.CardModel.TryPlayCard()
```

This method was confirmed live through the app: clicking a hand card in the
tracker plays that exact card in-game. Do not reimplement play by manually
removing cards from piles or subtracting mana. `TryPlayCard()` is the game's
entrypoint and should remain the bridge target unless future game updates prove
otherwise.

The frontend no longer renders a separate `PLAY` button. Instead, the card
article itself is clickable only for live hand cards. Keyboard activation was
intentionally removed. The command result remains useful for failures and
diagnostics:

```text
InvocationMethod
InvocationReturnValue
InvocationError
```

The app polls `command-result.json` until the matching command ID appears; a
single delayed/stale result previously left `pendingCommandId` stuck until View
> Reload.

## Live Overlay Rendering

The hand-mana overlay started as IMGUI because it was the quickest way to draw
debug-style text from the bridge. In this game/runtime, IMGUI text was reliable,
but IMGUI backgrounds were not:

```text
GUI.DrawTexture -> NotSupportedException
GUI.Label with style background -> no visible panel
GUI.Box with style background -> no visible panel
```

The working implementation uses normal Unity UI instead:

```text
Canvas(renderMode = ScreenSpaceOverlay, sortingOrder = short.MaxValue)
  Panel Image(color ~= End Turn parchment)
    Text(Arial built-in font, bold, muted brown)
```

This means future visual tweaks should adjust the `RectTransform`, `Image.color`,
and `Text` settings in `LiveBridgeBehaviour`, not the parked IMGUI helper.

## AssetRipper Notes

AssetRipper was useful to confirm exported C# stubs and script/class names, but it did not expose the custom CardConfig payload in YAML/JSON. It showed only shallow Unity fields for MagicWand:

```text
m_Name: Card_A_0_MagicWand
m_Script: CardConfig
```

AssetRipper export also generated a large temporary project and logs. Do not commit these.

## Card And Gem Text

Rules text is not a single complete, clean table for every card. The current
tracker builds practical display text with a layered approach:

1. Read English localization entries where they are directly referenced.
2. Decode common command/effect names from raw `CardConfig`, `FccConfig`, and
   `GemConfig` payloads.
3. Decode simple numeric fields where reliable, such as `_armorAmount`,
   `_healAmount`, and `_reduceAmount`.
4. Apply explicit overrides for cards/gems that the user has checked in-game.

The source of truth for manual display overrides is:

```text
data\display-overrides.csv
```

The game ID-to-name mapping source is:

```text
data\game-item-names.csv
```

`game-item-names.csv` stores `kind,id,name`. `display-overrides.csv` is
deduplicated by `name` and stores `name,game_text,text,tooltip,gold,color`. The
builders still contain generic decoding rules and effect templates, but manual
wording belongs in the CSV, not in hard-coded Python dictionaries. For rows
present in the CSV, the CSV `text` wins after the row name is expanded back to
matching IDs through `game-item-names.csv`. Blank CSV text is meaningful and
means the card/gem should show no rules text. `game_text` is reference text
generated from the game-data decoder for comparison. The CSV `gold` column is
also source data; it lists the exact words/tokens the frontend should highlight
in gold, separated with `|`. The CSV `tooltip` column is optional helper copy
for card rules hover tooltips; pipe-separated entries become separate lines. For
card rows, the CSV `color` column is source data for the card color/type class
shown in the frontend.

Generated text outputs are tracked app-owned artifacts:

```text
public\assets\card-text.json
public\assets\gem-text.json
public\assets\text-meta.json
```

Extracted art, art manifests, and generated art maps remain local ignored
artifacts because they are rebuilt from each user's installed game files.

Known decoded examples:

```text
GemConfig_Armor -> ArmorEffect, _armorAmount = 2 -> Add 2 Armor.
Card_M_0_Wings / Card_W_Wings -> WingsEffect, _reduceAmount = 1 -> Reduce Mana cost of next card played by 1.
FCC_Antonio -> ArmorEffect before fccActions, then AttackCardTypeTrigger + MightEffect.
```

For crawler cards, `FccConfig` serializes base effects before `fccActions` and
triggered effects after `_triggerType` blocks. The app formats crawler rules
with line breaks after the base sentence and before `Duration:`.

Some observed in-game wording intentionally differs from generic effect names.
Examples:

```text
Spellbinder -> Duration : Crawlers trigger XX more abilities before leaving.
Candelabrador -> Area : Attacks deal XX% splash damage.
Sprig o' Spinach -> Might : Deal XX% more damage.
Garlic -> Deal XX damage to the front row. / Disarm.
```

Do not assume every number should be highlighted as a variable. Wings uses a
literal `1`, so the frontend leaves it white. Percentage placeholders should be
highlighted as a complete token, including the `%` symbol.

