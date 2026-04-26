const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const { loadConfig } = require("./src/config");

const DEFAULT_SAVE_PATH = path.join(
  os.homedir(),
  "AppData",
  "LocalLow",
  "Nosebleed Interactive",
  "Vampire Crawlers",
  "Save",
  "SaveProfile0.save",
);
const DEFAULT_PUBLIC_DIR = path.join(__dirname, "public");

function walk(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }

  if (!value || typeof value !== "object") return;
  visit(value);

  for (const child of Object.values(value)) {
    walk(child, visit);
  }
}

function normalizeCard(card, pileId, index, cardCosts = {}) {
  const cardId = card.CardConfigId || "UnknownCard";
  const baseId = card.BaseCardConfigId || cardId;
  const baseCost = getCardCost(cardId, baseId, cardCosts);
  const manaModifier = Number(card.ManaCostModifier || 0);
  const tempManaModifier = Number(card.TempManaCostModifier || 0);
  const confusedManaModifier = Number(card.ConfusedManaCostModifier || 0);
  const gems = Array.isArray(card.GemIds) ? card.GemIds : [];
  const cost = getEffectiveCardCost(baseCost, {
    manaModifier,
    tempManaModifier,
    confusedManaModifier,
    gems,
  });

  return {
    pileId,
    index,
    cardId,
    baseId,
    baseCost,
    cost,
    guid: card.CardGuid || "",
    temporary: Boolean(card.IsTemporary),
    broken: Boolean(card.IsBroken),
    copyWithDestroy: Boolean(card.IsCopyWithDestroy),
    crackStage: card.CardCrackStage || 0,
    limitBreaks: card.TimesLimitBroken || 0,
    manaModifier,
    tempManaModifier,
    confusedManaModifier,
    gems,
  };
}

function getCardCost(cardId, baseId, cardCosts = {}) {
  if (Object.prototype.hasOwnProperty.call(cardCosts, cardId)) return Number(cardCosts[cardId]);
  if (cardId === baseId && Object.prototype.hasOwnProperty.call(cardCosts, baseId)) {
    return Number(cardCosts[baseId]);
  }
  if ((cardId || "").startsWith("FCC_")) return "FCC";
  return "Unknown";
}

function getGemManaModifier(gems) {
  return gems.reduce((total, gemId) => {
    const match = /^GemConfig_Mana_?(Plus|Minus)(\d+)$/.exec(gemId || "");
    if (!match) return total;

    const amount = Number(match[2]);
    if (!Number.isFinite(amount)) return total;
    if (match[1] === "Plus") return total + amount;
    if (match[1] === "Minus") return total - amount;
    return total;
  }, 0);
}

function getEffectiveCardCost(baseCost, card) {
  if (typeof baseCost !== "number") return baseCost;

  const modifier =
    card.manaModifier +
    card.tempManaModifier +
    card.confusedManaModifier +
    getGemManaModifier(card.gems);
  return baseCost + modifier;
}

function getDeckSnapshot(savePath, options = {}) {
  const raw = fs.readFileSync(savePath, "utf8");
  const parsed = JSON.parse(raw);
  const cardCosts = options.cardCosts || {};
  const piles = [];
  const cards = [];

  walk(parsed, (node) => {
    if (typeof node.cardPileId !== "string" || !Array.isArray(node.cards)) return;

    const pileCards = node.cards.map((card, index) =>
      normalizeCard(card, node.cardPileId, index, cardCosts),
    );
    piles.push({
      pileId: node.cardPileId,
      count: pileCards.length,
      currentCombo: node.CurrentCombo || 0,
      cards: pileCards,
    });
    cards.push(...pileCards);
  });

  const counts = Array.from(
    cards.reduce((map, card) => {
      const current = map.get(card.cardId) || {
        cardId: card.cardId,
        baseId: card.baseId,
        count: 0,
        piles: {},
        gems: new Set(),
      };
      current.count += 1;
      current.piles[card.pileId] = (current.piles[card.pileId] || 0) + 1;
      for (const gem of card.gems) current.gems.add(gem);
      map.set(card.cardId, current);
      return map;
    }, new Map()).values(),
    (entry) => ({ ...entry, gems: Array.from(entry.gems) }),
  ).sort((a, b) => b.count - a.count || a.cardId.localeCompare(b.cardId));

  const costCounts = Array.from(
    cards.reduce((map, card) => {
      const key = String(card.cost);
      const current = map.get(key) || { cost: card.cost, count: 0, piles: {} };
      current.count += 1;
      current.piles[card.pileId] = (current.piles[card.pileId] || 0) + 1;
      map.set(key, current);
      return map;
    }, new Map()).values(),
  ).sort((a, b) => {
    const aNum = typeof a.cost === "number";
    const bNum = typeof b.cost === "number";
    if (aNum && bNum) return a.cost - b.cost;
    if (aNum) return -1;
    if (bNum) return 1;
    return String(a.cost).localeCompare(String(b.cost));
  });

  return {
    savePath,
    lastModified: fs.statSync(savePath).mtime.toISOString(),
    profileId: parsed?.Data?.ProfileId || parsed?.Data?.GameSaveData?.ProfileId || "",
    totalCards: cards.length,
    piles: piles.sort((a, b) => a.pileId.localeCompare(b.pileId)),
    cards,
    counts,
    costCounts,
  };
}

function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".html" ? "text/html; charset=utf-8" :
    ext === ".css" ? "text/css; charset=utf-8" :
    ext === ".js" ? "text/javascript; charset=utf-8" :
    ext === ".png" ? "image/png" :
    "application/octet-stream";
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "content-type": contentTypeFor(filePath) });
    res.end(data);
  });
}

function resolveStaticPath(urlPath, publicDir, generatedDir) {
  const publicPath = path.normalize(path.join(publicDir, urlPath));
  if (publicPath.startsWith(publicDir) && fs.existsSync(publicPath)) return publicPath;

  if (generatedDir && urlPath.startsWith("/assets/")) {
    const generatedPath = path.normalize(path.join(generatedDir, urlPath));
    if (generatedPath.startsWith(generatedDir) && fs.existsSync(generatedPath)) return generatedPath;
  }

  return null;
}

function serveStatic(req, res, publicDir, generatedDir) {
  const urlPath = req.url === "/" ? "/index.html" : decodeURIComponent(req.url);
  const filePath = resolveStaticPath(urlPath, publicDir, generatedDir);

  if (!filePath) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  if (!filePath.startsWith(publicDir) && !(generatedDir && filePath.startsWith(generatedDir))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  sendFile(res, filePath);
}

function startServer(options = {}) {
  const config = options.config || loadConfig(options.userDataDir);
  const port = Number(options.port ?? process.env.PORT ?? 5177);
  const savePath = options.savePath || process.env.VC_SAVE_PATH || config.savePath || DEFAULT_SAVE_PATH;
  const publicDir = options.publicDir || DEFAULT_PUBLIC_DIR;
  const generatedDir = options.generatedDir || config.generatedDir || path.join(publicDir, "assets");
  const artManifestPath = options.artManifestPath || path.join(generatedDir, "assets", "art-manifest.json");
  const cardMapPath = options.cardMapPath || path.join(generatedDir, "assets", "card-map.json");
  const cardCostsPath = options.cardCostsPath || path.join(generatedDir, "assets", "card-costs.json");
  const fallbackArtManifestPath = path.join(publicDir, "assets", "art-manifest.json");
  const fallbackCardMapPath = path.join(publicDir, "assets", "card-map.json");
  const fallbackCardCostsPath = path.join(publicDir, "assets", "card-costs.json");

  const server = http.createServer((req, res) => {
    if (req.url === "/api/deck") {
      try {
        const cardCosts = readJsonIfExists(
          cardCostsPath,
          readJsonIfExists(fallbackCardCostsPath, {}),
        );
        sendJson(res, 200, getDeckSnapshot(savePath, { cardCosts }));
      } catch (error) {
        sendJson(res, 500, { error: error.message, savePath });
      }
      return;
    }

    if (req.url === "/api/config") {
      sendJson(res, 200, {
        ...config,
        savePath,
        hasSave: fs.existsSync(savePath),
        hasGame: Boolean(config.gameDir && fs.existsSync(config.gameDir)),
        hasArt: fs.existsSync(cardMapPath) || fs.existsSync(fallbackCardMapPath),
        hasCardCosts: fs.existsSync(cardCostsPath) || fs.existsSync(fallbackCardCostsPath),
      });
      return;
    }

    if (req.url === "/api/art") {
      sendJson(res, 200, {
        manifest: readJsonIfExists(artManifestPath, readJsonIfExists(fallbackArtManifestPath, [])),
        cardMap: readJsonIfExists(cardMapPath, readJsonIfExists(fallbackCardMapPath, {})),
      });
      return;
    }

    if (req.url === "/api/card-map") {
      sendJson(res, 200, readJsonIfExists(cardMapPath, readJsonIfExists(fallbackCardMapPath, {})));
      return;
    }

    serveStatic(req, res, publicDir, generatedDir);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const url = `http://127.0.0.1:${address.port}`;
      console.log(`Vampire Crawlers deck tracker: ${url}`);
      console.log(`Reading: ${savePath}`);
      resolve({ server, url, port: address.port, config, savePath });
    });
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  getDeckSnapshot,
  startServer,
};
