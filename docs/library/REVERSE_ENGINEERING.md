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

- `build_card_map.py` currently maps through card groups and sprites mostly from `globalgamemanagers.assets`.
- Some configs may remain unmapped, especially evolved/special cards.

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

This is why `server.js` does not use `baseId` as a general fallback for cost. If `cardCosts[cardId]` is missing, showing `Unknown` is better than silently showing the base card’s wrong cost.

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

## AssetRipper Notes

AssetRipper was useful to confirm exported C# stubs and script/class names, but it did not expose the custom CardConfig payload in YAML/JSON. It showed only shallow Unity fields for MagicWand:

```text
m_Name: Card_A_0_MagicWand
m_Script: CardConfig
```

AssetRipper export also generated a large temporary project and logs. Do not commit these.

