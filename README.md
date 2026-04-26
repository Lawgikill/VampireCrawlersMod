# Vampire Crawlers Deck Tracker

Read-only second-screen deck tracker for **Vampire Crawlers**.

## Desktop App

Development launch:

```powershell
npm install
npm run desktop
```

Build a Windows installer:

```powershell
npm run build:win
```

The desktop app auto-detects the default Steam install and save file, starts the local tracker server internally, and opens the UI in an app window.

Generated art and card-cost data are stored in the user's app data folder:

```text
%APPDATA%\VampireCrawlersDeckTracker\generated
```

The app should not ship extracted Vampire Crawlers PNGs. Each user rebuilds local art from their own installed copy. A small fallback card-cost map ships with the app and can be regenerated from the installed game.

Current art-cache rebuild requirement:

```powershell
python -m pip install UnityPy pillow
```

For distributable builds, bundle the extraction helper first so non-technical users do not need Python installed:

```powershell
python -m pip install pyinstaller UnityPy fmod_toolkit archspec pillow
npm run build-asset-builder
npm run build:win
```

## Browser Prototype

The current prototype reads the active save file from:

```text
%USERPROFILE%\AppData\LocalLow\Nosebleed Interactive\Vampire Crawlers\Save\SaveProfile0.save
```

It watches the serialized card piles already written by the game:

- `HandPile`
- `DrawPile`
- `DiscardPile`
- `ComboPile`
- any other `cardPileId` blocks found in the save

## Run

```powershell
npm start
```

Then open:

```text
http://127.0.0.1:5177
```

Open the extracted art browser:

```text
http://127.0.0.1:5177/art.html
```

## Extract Art

```powershell
python tools\extract_art.py --min-size 16
python tools\build_card_map.py
python tools\build_card_cost_map.py
```

The extractor writes PNG sprites to `public/assets/art` and metadata to `public/assets/art-manifest.json`.
The mapper reads Unity `CardConfig` and `CardGroup` objects and writes `public/assets/card-map.json`.
The cost mapper reads Unity `CardConfig` mana fields and writes `public/assets/card-costs.json`.

Manual overrides can still be added to `public/assets/card-map.json`:

```json
{
  "Card_A_1_MagicWand": "assets/art/WandHoly_e2f29fa6df.png"
}
```

A first large-sprite contact sheet is available at:

```text
http://127.0.0.1:5177/assets/contact-sheet-large.png
```

## Notes

This first pass does not edit saves, patch game files, inject code, or read process memory. It polls `/api/deck` every two seconds and refreshes the browser UI.

If the save only updates at room boundaries or after major events, the next step is a BepInEx IL2CPP plugin that hooks the game-side card pile model and exports a small local JSON file or localhost API for this same dashboard.
