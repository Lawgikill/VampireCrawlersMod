const state = {
  snapshot: null,
  cardMap: {},
  cardNames: {},
  cardText: {},
  textMeta: {},
  gemMap: {},
  gemText: {},
  evolutions: [],
  costFilterKey: "",
  sortBy: "cost",
  frequencySort: "name",
  cardViewMode: "all",
  onlyComboCards: false,
  hideBreakingCards: false,
  alwaysShowAttractorb: false,
  sidebarColumnHidden: false,
  config: null,
  pendingCommandId: "",
  pendingCommandStartedAt: 0,
  setupHiddenThisSession: false,
  handVisualLatchSignature: "",
  latchedComboHighlights: new Set(),
  learnedShatterStages: new Map(),
  previousIsInCombat: null,
};

const els = {
  subtitle: document.querySelector("#subtitle"),
  updatedAt: document.querySelector("#updatedAt"),
  sortBy: document.querySelector("#sortBy"),
  frequencySort: document.querySelector("#frequencySort"),
  setupPanel: document.querySelector("#setupPanel"),
  setupStatus: document.querySelector("#setupStatus"),
  hideSetup: document.querySelector("#hideSetup"),
  hideSetupForever: document.querySelector("#hideSetupForever"),
  rebuildArt: document.querySelector("#rebuildArt"),
  setupLog: document.querySelector("#setupLog"),
  updatePanel: document.querySelector("#updatePanel"),
  updateStatus: document.querySelector("#updateStatus"),
  checkUpdates: document.querySelector("#checkUpdates"),
  clearCostFilter: document.querySelector("#clearCostFilter"),
  costs: document.querySelector("#costs"),
  counts: document.querySelector("#counts"),
  allCardsLabel: document.querySelector("#allCardsLabel"),
  handCardsLabel: document.querySelector("#handCardsLabel"),
  currentMana: document.querySelector("#currentMana"),
  handManaTotal: document.querySelector("#handManaTotal"),
  commandStatus: document.querySelector("#commandStatus"),
  drawPileCount: document.querySelector("#drawPileCount"),
  discardPileCount: document.querySelector("#discardPileCount"),
  comboPileCount: document.querySelector("#comboPileCount"),
  mainLayout: document.querySelector("#mainLayout"),
  sidebarColumn: document.querySelector("#sidebarColumn"),
  toggleSidebarColumn: document.querySelector("#toggleSidebarColumn"),
  evolutionsButton: document.querySelector("#evolutionsButton"),
  evolutionDialog: document.querySelector("#evolutionDialog"),
  evolutionClose: document.querySelector("#evolutionClose"),
  evolutionRecipes: document.querySelector("#evolutionRecipes"),
  startupSetupDialog: document.querySelector("#startupSetupDialog"),
  startupSetupTitle: document.querySelector("#startupSetupTitle"),
  startupSetupMessage: document.querySelector("#startupSetupMessage"),
  startupSetupLog: document.querySelector("#startupSetupLog"),
  startupSetupRetry: document.querySelector("#startupSetupRetry"),
  cardViewMode: document.querySelector("#cardViewMode"),
  onlyComboCards: document.querySelector("#onlyComboCards"),
  hideBreakingCards: document.querySelector("#hideBreakingCards"),
  alwaysShowAttractorb: document.querySelector("#alwaysShowAttractorb"),
  cards: document.querySelector("#cards"),
};

const WILD_COST_ICON_PATH = "/assets/art/UI_sprites_icon_wild_702ec41b2e.png";
const COST_SEGMENT_ORDER = ["attack", "support", "defence", "buff", "utility", "crawler", "unknown"];
const COST_SEGMENT_LABELS = {
  attack: "Attack",
  support: "Support",
  defence: "Defence",
  buff: "Buff",
  utility: "Utility",
  crawler: "Crawler",
  unknown: "Unknown",
};
const EVOLUTION_OPEN_SLOT_EXEMPT_RESULTS = new Set([
  "Card_A_5_Vandalier",
  "Card_A_4_Phieraggi",
]);
const VANDALIER_RESULT_ID = "Card_A_5_Vandalier";
const PHIERAGGI_RESULT_ID = "Card_A_4_Phieraggi";

function cleanId(id) {
  return String(id || "")
    .replace(/^Card_/, "")
    .replace(/^FCC_/, "Crawler: ")
    .replace(/_/g, " ");
}

function splitIdentifier(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resolveDisplayTokens(value) {
  const replacements = {
    "{GlobalKeywords.Armor}": "Armor",
    "{GlobalKeywords.Mana}": "Mana",
    "{GlobalKeywords.Crawler}": "Crawler",
    "{GlobalKeywords.Amount}": "Amount",
    "{GlobalKeywords.Area}": "Area",
    "{GlobalKeywords.Duration}": "Duration",
    "{GlobalKeywords.Handsize}": "Hand",
    "{GlobalKeywords.Luck}": "Luck",
    "{GlobalKeywords.Might}": "Might",
  };

  return Object.entries(replacements).reduce(
    (text, [source, replacement]) => text.replaceAll(source, replacement),
    String(value || ""),
  );
}

function formatRulesTextHtml(value, card) {
  let text = escapeHtml(value);
  if (/^FCC_/.test(card?.cardId || "") || /^FCC_/.test(card?.baseId || "")) {
    text = text.replace(/\. /, ".<br>");
    text = text.replace(/\. Duration:/g, ".<br>Duration:");
  }
  text = text.replace(/\r?\n/g, "<br>");
  if (card?.cardId === "Card_M_0_Wings" || card?.cardId === "Card_W_Wings") {
    return text;
  }
  return highlightConfiguredTokens(text, card?.cardId || card?.baseId);
}

function rulesTooltipEntries(card) {
  const entries = [];
  if (state.textMeta[card?.cardId]?.tooltip) {
    entries.push({ text: state.textMeta[card.cardId].tooltip, id: card.cardId });
  } else if (state.textMeta[card?.baseId]?.tooltip) {
    entries.push({ text: state.textMeta[card.baseId].tooltip, id: card.baseId });
  }

  (card?.gems || []).forEach((gem) => {
    const text = state.textMeta[gem]?.tooltip || "";
    if (text) entries.push({ text, id: gem });
  });

  return entries;
}

function formatRulesTooltipHtml(entries) {
  return (entries || [])
    .map((entry) => {
      const text = escapeHtml(entry.text).replace(/\r?\n/g, "<br>");
      return `<span>${highlightConfiguredTokens(text, entry.id)}</span>`;
    })
    .join("");
}

function formatGemRulesHtml(gems) {
  return (gems || [])
    .map((gem) => {
      const rawText = gemRulesText(gem);
      if (!rawText) return "";
      const text = highlightRuleValues(
        highlightConfiguredTokens(escapeHtml(punctuateSentence(rawText)).replace(/\r?\n/g, "<br>"), gem),
        null,
      );
      return `<span class="gem-rule">${text}</span>`;
    })
    .join("");
}

function highlightRuleValues(text, pattern) {
  if (!pattern) return text;
  return text.replace(pattern, `<span class="rules-value">$1</span>`);
}

function highlightConfiguredTokens(text, id) {
  const tokens = state.textMeta[id]?.gold || [];
  if (!tokens.length) return text;

  const pattern = new RegExp(
    `(?<![\\w%])(${tokens.map(escapeRegExp).sort((a, b) => b.length - a.length).join("|")})(?![\\w%])`,
    "g",
  );
  return highlightRuleValues(text, pattern);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fitCardTitles() {
  for (const name of els.cards.querySelectorAll(".card-name")) {
    name.style.fontSize = "";
    const baseSize = Number.parseFloat(getComputedStyle(name).fontSize);
    if (!baseSize) continue;

    let size = baseSize;
    const minimumSize = 8;
    while (name.scrollWidth > name.clientWidth && size > minimumSize) {
      size -= 0.5;
      name.style.fontSize = `${size}px`;
    }
  }
}

function gemDisplayName(id) {
  const gemId = String(id || "");
  const name = gemId.replace(/^GemConfig_?/, "");
  const manaMatch = /^Mana_?(Plus|Minus)(\d+)$/i.exec(name);
  if (manaMatch) {
    const sign = manaMatch[1].toLowerCase() === "plus" ? "+" : "-";
    return `Mana ${sign}${manaMatch[2]}`;
  }
  return splitIdentifier(name);
}

function gemArtPath(id) {
  return state.gemMap[id] || "";
}

function gemRulesText(id) {
  if (Object.prototype.hasOwnProperty.call(state.gemText, id)) return state.gemText[id];
  return gemDisplayName(id);
}

function punctuateSentence(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function parseCardId(id) {
  const match = /^Card_([A-Z])_(\d+)_(.+)$/.exec(id || "");
  if (!match) return null;
  return {
    type: match[1],
    cost: Number(match[2]),
    name: match[3].replace(/_/g, " "),
  };
}

function cardDisplayName(id) {
  if (state.cardNames[id]) return resolveDisplayTokens(state.cardNames[id]);
  const parsed = parseCardId(id);
  if (parsed) return parsed.name;
  return cleanId(id);
}

function normalizeMatchName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function cardRulesText(id) {
  return state.cardText[id] || "";
}

function cardTypeClass(card) {
  const color = state.textMeta[card.cardId]?.color || state.textMeta[card.baseId]?.color || "";
  const colorClass = {
    attack: "card-type-attack",
    red: "card-type-attack",
    support: "card-type-support",
    yellow: "card-type-support",
    buff: "card-type-buff",
    utility: "card-type-utility",
    purple: "card-type-utility",
    crawler: "card-type-crawler",
    green: "card-type-crawler",
    defence: "card-type-defence",
    defense: "card-type-defence",
    blue: "card-type-defence",
    unknown: "card-type-unknown",
    grey: "card-type-unknown",
    gray: "card-type-unknown",
  }[String(color).toLowerCase()];
  if (colorClass) return colorClass;
  if (card.cost === "FCC") return "card-type-crawler";
  if (/^FCC_/.test(card.cardId || "")) return "card-type-crawler";
  const parsed = parseCardId(card.cardId);
  return {
    A: "card-type-attack",
    S: "card-type-support",
    B: "card-type-buff",
    D: "card-type-defence",
    M: "card-type-utility",
  }[parsed?.type] || "card-type-unknown";
}

function cardTypeKey(card) {
  const className = cardTypeClass(card);
  return className.replace(/^card-type-/, "") || "unknown";
}

function costRank(cost) {
  return typeof cost === "number" ? cost : 99;
}

function costFilterKeyForCard(card) {
  if ((card.cardId || "").startsWith("FCC_")) return `crawler:${card.cost}`;
  if (card.cost === "W") return "wild";
  if (typeof card.cost === "number") return `mana:${card.cost}`;
  return `unknown:${card.cost}`;
}

function isAttractorb(card) {
  return /(^|_)Attractorb$/i.test(card?.cardId || "")
    || /(^|_)Attractorb$/i.test(card?.baseId || "")
    || cardDisplayName(card?.cardId).toLowerCase() === "attractorb"
    || cardDisplayName(card?.baseId).toLowerCase() === "attractorb";
}

function isComboContinuer(card) {
  return card?.comboCostHighlighted || card?.cost === "W";
}

function cardMatches(card) {
  if (state.costFilterKey && costFilterKeyForCard(card) !== state.costFilterKey) return false;
  if (state.alwaysShowAttractorb && isAttractorb(card)) return true;
  if (state.onlyComboCards && !isComboContinuer(card)) return false;
  if (state.hideBreakingCards && cardCrackOverlayStage(card) === "2") return false;
  return true;
}

function sortCards(cards) {
  const sorted = [...cards];
  sorted.sort((a, b) => {
    if (state.sortBy === "cost") {
      return costRank(a.cost) - costRank(b.cost)
        || a.cardId.localeCompare(b.cardId)
        || a.index - b.index;
    }
    if (state.sortBy === "name") return a.cardId.localeCompare(b.cardId);
    if (state.sortBy === "gems") return b.gems.length - a.gems.length || a.cardId.localeCompare(b.cardId);
    return a.cardId.localeCompare(b.cardId);
  });
  return sorted;
}

function renderCounts(snapshot) {
  const counts = [...snapshot.counts].sort((a, b) => {
    const nameSort = cardDisplayName(a.cardId).localeCompare(cardDisplayName(b.cardId), undefined, { sensitivity: "base" })
      || a.cardId.localeCompare(b.cardId);

    if (state.frequencySort === "count") {
      return b.count - a.count || nameSort;
    }

    return nameSort;
  });

  els.counts.innerHTML = counts
    .map((entry) => `
      <div class="count-row">
        <span>${cardDisplayName(entry.cardId)}</span>
        <span class="badge">${entry.count}</span>
      </div>
    `)
    .join("");
}

function renderCosts(snapshot) {
  const costCounts = snapshot.costCounts || [];
  const hiddenHistogramCostKeys = getHiddenHistogramCostKeys(snapshot.cards || []);
  const histogramCosts = [
    ...costCounts.filter((entry) => entry.kind === "wild"),
    ...costCounts.filter(isManaCostEntry),
  ].filter((entry) => !hiddenHistogramCostKeys.has(entry.key));
  const otherCosts = costCounts.filter((entry) => !isManaCostEntry(entry) && entry.kind !== "wild");

  if (hiddenHistogramCostKeys.has(state.costFilterKey)) {
    state.costFilterKey = "";
  }

  els.clearCostFilter.disabled = !state.costFilterKey;
  els.costs.innerHTML = [
    renderCostHistogram(histogramCosts, snapshot.cards || []),
    renderCostRows(otherCosts),
  ].filter(Boolean).join("");
}

function isPentagramCard(card) {
  return card?.cardId === "Card_A_4_Pentagram" || card?.cardId === "Card_A_5_Pentagram";
}

function getHiddenHistogramCostKeys(cards) {
  const cardsByCostKey = new Map();

  cards.forEach((card) => {
    const costKey = costFilterKeyForCard(card);
    const costCards = cardsByCostKey.get(costKey) || [];
    costCards.push(card);
    cardsByCostKey.set(costKey, costCards);
  });

  return new Set(Array.from(cardsByCostKey.entries())
    .filter(([, costCards]) => costCards.length === 1 && isPentagramCard(costCards[0]))
    .map(([costKey]) => costKey));
}

function isManaCostEntry(entry) {
  if (!entry) return false;
  if (entry.kind === "mana") return true;
  return typeof entry.cost === "number" && !String(entry.key || "").startsWith("crawler:");
}

function buildCostSegments(cards) {
  const countsByCost = new Map();

  cards.forEach((card) => {
    const costKey = costFilterKeyForCard(card);
    const typeKey = cardTypeKey(card);
    const counts = countsByCost.get(costKey) || new Map();
    counts.set(typeKey, (counts.get(typeKey) || 0) + 1);
    countsByCost.set(costKey, counts);
  });

  return new Map(Array.from(countsByCost.entries()).map(([costKey, counts]) => [
    costKey,
    COST_SEGMENT_ORDER
      .map((type) => ({ type, count: counts.get(type) || 0 }))
      .filter((segment) => segment.count > 0),
  ]));
}

function renderCostBarSegments(segments, total) {
  if (!total || !segments.length) return "";

  return segments
    .map((segment) => {
      const label = COST_SEGMENT_LABELS[segment.type] || COST_SEGMENT_LABELS.unknown;
      const percent = (segment.count / total) * 100;
      return `<span class="cost-bar-segment cost-bar-segment-${escapeHtml(segment.type)}" style="height: ${percent}%" title="${escapeHtml(label)}: ${segment.count}"></span>`;
    })
    .join("");
}

function renderCostHistogram(entries, cards) {
  if (!entries.length) return "";

  const segmentsByCost = buildCostSegments(cards);
  const manaEntries = entries.filter(isManaCostEntry);
  const wildEntry = entries.find((entry) => entry.kind === "wild");
  const costs = manaEntries
    .map((entry) => entry.cost)
    .filter((cost) => typeof cost === "number");
  const minCost = Math.min(0, ...costs);
  const maxCost = Math.max(0, ...costs);
  const entriesByCost = new Map(manaEntries.map((entry) => [entry.cost, entry]));
  const manaCurveEntries = Array.from({ length: maxCost - minCost + 1 }, (_, index) => {
    const cost = minCost + index;
    return entriesByCost.get(cost) || {
      key: `mana:${cost}`,
      kind: "mana",
      cost,
      label: String(cost),
      count: 0,
    };
  });
  const curveEntries = [
    wildEntry ? { ...wildEntry, label: "W" } : { key: "wild", kind: "wild", cost: "W", label: "W", count: 0 },
    ...manaCurveEntries,
  ];
  const maxCount = Math.max(...curveEntries.map((entry) => entry.count || 0), 1);

  return `
    <div class="cost-histogram" aria-label="Mana cost curve">
      ${curveEntries.map((entry) => {
        const count = entry.count || 0;
        const height = count ? Math.max(12, Math.round((count / maxCount) * 100)) : 0;
        const isActive = state.costFilterKey === entry.key;
        const segments = segmentsByCost.get(entry.key) || [];

        return `
          <button class="cost-bar-group${isActive ? " is-active" : ""}" type="button" data-cost-key="${escapeHtml(entry.key)}" title="${formatCostEntry(entry)}: ${count}"${count ? "" : " disabled"}>
            <div class="cost-bar-shell">
              ${count ? `<div class="cost-bar-count" style="bottom: calc(${height}% + 4px)">${count}</div>` : ""}
              <div class="cost-bar${count ? "" : " is-empty"}" style="height: ${height}%">${renderCostBarSegments(segments, count)}</div>
            </div>
            <div class="cost-bar-label">${formatCostEntry(entry)}</div>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function renderCostRows(entries) {
  return entries
    .map((entry) => {
      const isActive = state.costFilterKey === entry.key;
      return `
      <button class="count-row cost-filter-row${isActive ? " is-active" : ""}" type="button" data-cost-key="${escapeHtml(entry.key)}">
        <span>${formatCostEntry(entry)}</span>
        <span class="badge">${entry.count}</span>
      </button>
    `;
    })
    .join("");
}

function formatCostEntry(entry) {
  if (entry?.label) return entry.label;
  return formatCost(entry?.cost);
}

function formatCost(cost) {
  if (typeof cost === "number") return `${cost} mana`;
  if (cost === "FCC") return "Crawler";
  if (cost === "W") return "Wild";
  return cost;
}

function formatCostSymbol(cost) {
  if (typeof cost === "number") return String(cost);
  if (cost === "FCC") return "C";
  if (cost === "W") return "W";
  return "?";
}

function renderManaCost(card) {
  const cost = card?.cost;
  const comboClass = card?.comboCostHighlighted ? " mana-cost-combo" : "";
  if (cost === "W") {
    return `
      <span class="mana-cost mana-cost-wild${comboClass}" title="${formatCost(cost)}">
        <img src="${WILD_COST_ICON_PATH}" alt="Wild" onerror="this.hidden=true; this.nextElementSibling.hidden=false">
        <span class="mana-cost-fallback" hidden>W</span>
      </span>
    `;
  }
  return `<span class="mana-cost${comboClass}" title="${formatCost(cost)}">${formatCostSymbol(cost)}</span>`;
}

function comboHighlightKey(card) {
  return card?.guid || `${card?.pileId || ""}:${card?.index ?? ""}:${card?.cardId || ""}`;
}

function cardShatterKey(card) {
  return card?.guid || `${card?.cardId || ""}:${card?.baseId || ""}:${card?.index ?? ""}`;
}

function handVisualLatchKey(card) {
  return card?.guid || `${card?.cardId || ""}:${card?.baseId || ""}:${card?.index ?? ""}`;
}

function handVisualLatchSignature(snapshot) {
  if (!Array.isArray(snapshot?.cards)) return "";
  return snapshot.cards
    .filter((card) => card.pileId === "HandPile")
    .map(handVisualLatchKey)
    .filter(Boolean)
    .sort()
    .join("|");
}

function rawCardCrackOverlayStage(card) {
  const sprite = String(card?.cardCrackSprite || "").toLowerCase();
  const spriteStage = sprite.match(/shatter[\s_-]*(\d+)/)?.[1];
  if (spriteStage === "1" || spriteStage === "2") return spriteStage;

  const stage = Number(card?.breakableCrackStage || card?.crackStage || 0);
  if (stage >= 2) return "2";
  if (stage >= 1) return "1";

  return String(card?.crackState || "").toLowerCase() === "cracked" ? "1" : "";
}

function stabilizeHandVisualStates(snapshot) {
  if (snapshot?.isInCombat === false) {
    state.learnedShatterStages.clear();
  }

  if (!Array.isArray(snapshot?.cards)) {
    state.handVisualLatchSignature = "";
    state.latchedComboHighlights.clear();
    return snapshot;
  }

  if (snapshot.liveStateActive) {
    const signature = handVisualLatchSignature(snapshot);
    if (signature !== state.handVisualLatchSignature) {
      state.handVisualLatchSignature = signature;
      state.latchedComboHighlights.clear();
    }
  } else {
    state.handVisualLatchSignature = "";
    state.latchedComboHighlights.clear();
  }

  const activeKeys = new Set();
  for (const card of snapshot.cards) {
    const key = comboHighlightKey(card);
    if (key) {
      activeKeys.add(key);

      if (snapshot.liveStateActive && card.comboCostHighlighted) {
        state.latchedComboHighlights.add(key);
      } else if (state.latchedComboHighlights.has(key)) {
        card.comboCostHighlighted = true;
      }
    }

    const rawShatterStage = rawCardCrackOverlayStage(card);
    const shatterKey = cardShatterKey(card);
    if (snapshot.isInCombat === false) {
      card.suppressCrackOverlay = true;
      continue;
    }

    if (rawShatterStage && shatterKey && snapshot.liveStateActive && snapshot.isInCombat === true) {
      const existingStage = state.learnedShatterStages.get(shatterKey);
      state.learnedShatterStages.set(shatterKey, existingStage === "2" || rawShatterStage === "2" ? "2" : "1");
    }

    const learnedShatterStage = shatterKey ? state.learnedShatterStages.get(shatterKey) : "";
    if (learnedShatterStage) {
      card.latchedCrackOverlayStage = learnedShatterStage;
    }
  }

  for (const key of state.latchedComboHighlights) {
    if (!activeKeys.has(key)) state.latchedComboHighlights.delete(key);
  }

  return snapshot;
}

function applyCombatViewTransition(snapshot) {
  const isInCombat = snapshot?.isInCombat === true;
  if (state.previousIsInCombat === false && isInCombat && state.cardViewMode === "all") {
    state.cardViewMode = "hand";
    els.cardViewMode.checked = true;
  }
  state.previousIsInCombat = isInCombat;
}

function cardArtHtml(cardId, className = "recipe-card-art") {
  const artPath = state.cardMap[cardId] || "";
  const name = cardDisplayName(cardId);
  if (!artPath) {
    return `<span class="${className} recipe-card-art-missing" aria-hidden="true">${escapeHtml(name.slice(0, 1) || "?")}</span>`;
  }
  return `<img class="${className}" src="/${artPath}" alt="">`;
}

function buildEvolutionInventory() {
  const cards = state.snapshot?.cards || [];
  const byId = new Map();
  const byName = new Map();

  cards.forEach((card) => {
    const names = [
      card.cardId,
      card.baseId,
      cardDisplayName(card.cardId),
      cardDisplayName(card.baseId),
    ].filter(Boolean);

    const entry = {
      card,
      hasOpenSlot: Math.max(0, Number(card.openGemSlots) || 0) > 0,
    };

    [card.cardId, card.baseId].filter(Boolean).forEach((id) => {
      const bucket = byId.get(id) || [];
      bucket.push(entry);
      byId.set(id, bucket);
    });

    names.map(normalizeMatchName).filter(Boolean).forEach((name) => {
      const bucket = byName.get(name) || [];
      bucket.push(entry);
      byName.set(name, bucket);
    });
  });

  return { byId, byName };
}

function evolutionEntriesForCardId(cardId, inventory) {
  const byIdEntries = inventory.byId.get(cardId) || [];
  const byNameEntries = inventory.byName.get(normalizeMatchName(cardDisplayName(cardId))) || [];
  return [...byIdEntries, ...byNameEntries];
}

function evolutionOptionStatus(cardId, inventory, requiresOpenSlot) {
  const entries = evolutionEntriesForCardId(cardId, inventory);
  if (!entries.length) return "";
  if (!requiresOpenSlot || entries.some((entry) => entry.hasOpenSlot)) return "owned";
  return "";
}

function recipeRequiresOpenSlot(recipe, inputIndex) {
  return inputIndex === 0 && !EVOLUTION_OPEN_SLOT_EXEMPT_RESULTS.has(recipe.resultId);
}

function getRecipeAvailability(recipe, inventory) {
  if (recipe.resultId === VANDALIER_RESULT_ID) {
    const groups = recipe.inputs.map((group) => {
      const options = new Map((group || []).map((cardId) => [
        cardId,
        evolutionEntriesForCardId(cardId, inventory).length ? "owned" : "",
      ]));
      const entries = (group || []).flatMap((cardId) => evolutionEntriesForCardId(cardId, inventory));
      return {
        options,
        available: Array.from(options.values()).some(Boolean),
        hasOpenSlot: entries.some((entry) => entry.hasOpenSlot),
      };
    });
    const hasAllInputs = groups.length > 0 && groups.every((group) => group.available);
    const hasAnyOpenSlot = groups.some((group) => group.hasOpenSlot);

    if (hasAllInputs && !hasAnyOpenSlot) {
      groups.forEach((group) => {
        group.options.forEach((status, cardId) => {
          if (status) group.options.set(cardId, "blocked");
        });
      });
    }

    return {
      groups,
      complete: hasAllInputs && hasAnyOpenSlot,
      blocked: hasAllInputs && !hasAnyOpenSlot,
    };
  }

  if (recipe.resultId === PHIERAGGI_RESULT_ID) {
    const weaponInputIndexes = new Set([0, 1]);
    const groups = recipe.inputs.map((group, inputIndex) => {
      const options = new Map((group || []).map((cardId) => [
        cardId,
        evolutionEntriesForCardId(cardId, inventory).length ? "owned" : "",
      ]));
      const entries = (group || []).flatMap((cardId) => evolutionEntriesForCardId(cardId, inventory));
      return {
        options,
        available: Array.from(options.values()).some(Boolean),
        hasOpenSlot: weaponInputIndexes.has(inputIndex) && entries.some((entry) => entry.hasOpenSlot),
        isWeaponInput: weaponInputIndexes.has(inputIndex),
      };
    });
    const hasAllInputs = groups.length > 0 && groups.every((group) => group.available);
    const hasAnyWeaponOpenSlot = groups.some((group) => group.isWeaponInput && group.hasOpenSlot);

    if (hasAllInputs && !hasAnyWeaponOpenSlot) {
      groups.forEach((group) => {
        if (!group.isWeaponInput) return;
        group.options.forEach((status, cardId) => {
          if (status) group.options.set(cardId, "blocked");
        });
      });
    }

    return {
      groups,
      complete: hasAllInputs && hasAnyWeaponOpenSlot,
      blocked: hasAllInputs && !hasAnyWeaponOpenSlot,
    };
  }

  const groups = recipe.inputs.map((group, inputIndex) => {
    const requiresOpenSlot = recipeRequiresOpenSlot(recipe, inputIndex);
    const options = new Map((group || []).map((cardId) => [
      cardId,
      evolutionOptionStatus(cardId, inventory, requiresOpenSlot),
    ]));
    return {
      options,
      available: Array.from(options.values()).some(Boolean),
    };
  });

  return {
    groups,
    complete: groups.length > 0 && groups.every((group) => group.available),
    blocked: false,
  };
}

function getRecipeResultStatus(recipe, inventory) {
  return evolutionEntriesForCardId(recipe.resultId, inventory).length ? "owned" : "";
}

function markEvolutionCardState(states, cardId, stateValue) {
  const nameKey = normalizeMatchName(cardDisplayName(cardId));
  const keys = [cardId, nameKey].filter(Boolean);
  const rank = { component: 1, ready: 2 };

  keys.forEach((key) => {
    if ((rank[stateValue] || 0) > (rank[states.get(key)] || 0)) {
      states.set(key, stateValue);
    }
  });
}

function getEvolutionCardStates() {
  const inventory = buildEvolutionInventory();
  const states = new Map();

  state.evolutions.forEach((recipe) => {
    const availability = getRecipeAvailability(recipe, inventory);
    recipe.inputs.forEach((group, groupIndex) => {
      group.forEach((cardId) => {
        const status = availability.groups[groupIndex]?.options?.get(cardId);
        if (status !== "owned") return;
        markEvolutionCardState(states, cardId, availability.complete ? "ready" : "component");
      });
    });
  });

  return states;
}

function evolutionStateForCard(card, states) {
  const keys = [
    card.cardId,
    card.baseId,
    normalizeMatchName(cardDisplayName(card.cardId)),
    normalizeMatchName(cardDisplayName(card.baseId)),
  ].filter(Boolean);
  const rank = { component: 1, ready: 2 };
  return keys.reduce((best, key) => {
    const value = states.get(key) || "";
    return (rank[value] || 0) > (rank[best] || 0) ? value : best;
  }, "");
}

function renderRecipeOption(cardId, status = "") {
  return `
    <span class="recipe-card-token${status ? ` is-${status}` : ""}" title="${escapeHtml(cardDisplayName(cardId))}">
      ${cardArtHtml(cardId)}
      <span>${escapeHtml(cardDisplayName(cardId))}</span>
    </span>
  `;
}

function renderRecipeGroup(cardIds, groupAvailability) {
  const ids = Array.isArray(cardIds) ? cardIds : [];
  return `
    <span class="recipe-card-group${ids.length > 1 ? " has-alternates" : ""}${groupAvailability?.available ? " is-owned" : ""}">
      ${ids.map((cardId) => renderRecipeOption(cardId, groupAvailability?.options?.get(cardId))).join("")}
    </span>
  `;
}

function renderEvolutionRecipes() {
  const inventory = buildEvolutionInventory();
  els.evolutionRecipes.innerHTML = state.evolutions.length
    ? state.evolutions.map((recipe) => {
      const availability = getRecipeAvailability(recipe, inventory);
      const resultStatus = getRecipeResultStatus(recipe, inventory);
      return `
      <article class="evolution-recipe${availability.complete ? " is-complete" : ""}${availability.blocked ? " is-blocked" : ""}">
        <div class="recipe-equation recipe-input-count-${recipe.inputs.length}">
          ${recipe.inputs.map((group, index) => `
            ${index ? `<span class="recipe-operator recipe-operator-plus">+</span>` : ""}
            ${renderRecipeGroup(group, availability.groups[index])}
          `).join("")}
          <span class="recipe-operator recipe-operator-equals">=</span>
          <span class="recipe-result">
            ${renderRecipeOption(recipe.resultId, resultStatus)}
          </span>
        </div>
      </article>
    `;
    }).join("")
    : `<p class="muted">No evolution data loaded.</p>`;
}

function formatHandManaTotal(snapshot) {
  const handCards = snapshot.cards.filter((card) => card.pileId === "HandPile");
  const numericTotal = handCards.reduce((total, card) => total + (typeof card.cost === "number" ? card.cost : 0), 0);
  const extras = Array.from(
    handCards.reduce((map, card) => {
      if (typeof card.cost === "number") return map;
      const key = formatCostSymbol(card.cost);
      map.set(key, (map.get(key) || 0) + 1);
      return map;
    }, new Map()).entries(),
  ).map(([cost, count]) => `${count}${cost}`);

  return [String(numericTotal), ...extras].join(" + ");
}

function formatCurrentMana(snapshot) {
  const currentMana = Number.isFinite(snapshot?.currentMana)
    ? snapshot.currentMana
    : Number.isFinite(snapshot?.displayedMana)
      ? snapshot.displayedMana
      : null;
  return currentMana == null ? "--" : currentMana;
}

function pileCount(snapshot, pileId) {
  const pile = Array.isArray(snapshot?.piles)
    ? snapshot.piles.find((entry) => entry.pileId === pileId)
    : null;
  return Number.isFinite(pile?.count) ? pile.count : "--";
}

function updateSidebarColumnVisibility() {
  els.mainLayout.classList.toggle("is-sidebar-hidden", state.sidebarColumnHidden);
  els.sidebarColumn.hidden = state.sidebarColumnHidden;
  els.toggleSidebarColumn.textContent = state.sidebarColumnHidden ? "Show Column" : "Hide Column";
}

function renderGemSlots(card) {
  const openSlotCount = Math.max(0, Number(card.openGemSlots) || 0);
  const filledGems = Array.isArray(card.gems) ? card.gems : [];
  if (!openSlotCount && !filledGems.length) return "";

  return `
    <div class="gem-slot-stack" aria-label="${filledGems.length} filled gem slot${filledGems.length === 1 ? "" : "s"}, ${openSlotCount} open gem slot${openSlotCount === 1 ? "" : "s"}">
      ${filledGems.map((gem) => {
        const artPath = gemArtPath(gem);
        const gemName = escapeHtml(gemDisplayName(gem));
        if (artPath) {
          return `<span class="gem-slot-filled" title="${gemName}"><img src="/${artPath}" alt="${gemName}"></span>`;
        }
        return `<span class="gem-slot-filled gem-slot-label" title="${escapeHtml(gem)}">${gemName}</span>`;
      }).join("")}
      ${Array.from({ length: openSlotCount }, () => `<span class="gem-slot-empty" title="Open gem slot"></span>`).join("")}
    </div>
  `;
}

function cardCrackOverlayStage(card) {
  if (card?.suppressCrackOverlay) return "";
  return card?.latchedCrackOverlayStage || rawCardCrackOverlayStage(card);
}

function renderCardCrackOverlay(card) {
  const stage = cardCrackOverlayStage(card);
  if (!stage) return "";

  const warning = stage === "2"
    ? `<span class="card-break-warning" title="Will break on next use" aria-label="Will break on next use">!</span>`
    : "";
  return `<img class="card-crack-overlay card-crack-overlay-${stage}" src="/assets/overlays/shatter-${stage}.png" alt="">${warning}`;
}

function renderCards(snapshot) {
  const visibleCards = state.cardViewMode === "hand"
    ? snapshot.cards.filter((card) => card.pileId === "HandPile")
    : snapshot.cards;
  const allCardCount = snapshot.totalCards ?? snapshot.cards.length;
  const handCardCount = snapshot.cards.filter((card) => card.pileId === "HandPile").length;
  const cards = sortCards(visibleCards.filter(cardMatches));
  const evolutionCardStates = getEvolutionCardStates();
  els.allCardsLabel.textContent = `ALL CARDS (${allCardCount})`;
  els.handCardsLabel.textContent = `CARDS IN HAND (${handCardCount})`;
  els.allCardsLabel.classList.toggle("is-active", state.cardViewMode === "all");
  els.handCardsLabel.classList.toggle("is-active", state.cardViewMode === "hand");
  els.currentMana.textContent = `CURRENT MANA: ${formatCurrentMana(snapshot)}`;
  els.handManaTotal.textContent = `HAND MANA TOTAL: ${formatHandManaTotal(snapshot)}`;
  els.drawPileCount.textContent = `DRAW PILE: ${pileCount(snapshot, "DrawPile")}`;
  els.discardPileCount.textContent = `DISCARD PILE: ${pileCount(snapshot, "DiscardPile")}`;
  els.comboPileCount.textContent = `COMBO PILE: ${pileCount(snapshot, "ComboPile")}`;

  els.cards.innerHTML = cards.length
    ? cards.map((card) => {
      const statusLines = [
        card.temporary ? "Temporary" : "",
        card.broken ? "Broken" : "",
        card.copyWithDestroy ? "Destroy copy" : "",
        card.limitBreaks ? `Limit +${card.limitBreaks}` : "",
        card.manaModifier ? `Mana ${card.manaModifier}` : "",
      ].filter(Boolean);
      const artPath = state.cardMap[card.cardId] || state.cardMap[card.baseId] || "";
      const rulesText = cardRulesText(card.cardId) || cardRulesText(card.baseId);
      const gemRulesTextValue = card.gems.map((gem) => punctuateSentence(gemRulesText(gem))).filter(Boolean).join("\n");
      const rulesTextHtml = formatRulesTextHtml(rulesText, card);
      const gemRulesHtml = formatGemRulesHtml(card.gems);
      const statusLinesHtml = statusLines.length
        ? `<span class="status-lines">${statusLines.map((line) => `<span>${escapeHtml(line)}</span>`).join("")}</span>`
        : "";
      const hasEvolveGem = card.gems.includes("GemConfig_Evolve");
      const hasDescription = Boolean(rulesText || gemRulesHtml);
      const descriptionClass = hasEvolveGem ? "card-description card-description-clear" : "card-description";
      const evolutionState = evolutionStateForCard(card, evolutionCardStates);
      const evolutionMarker = evolutionState
        ? `<span class="evolution-card-marker evolution-card-marker-${evolutionState}" title="${evolutionState === "ready" ? "Evolution ready" : "Evolution component"}"></span>`
        : "";
      const cardTitleClass = `card-title${evolutionState ? ` has-evolution-marker has-evolution-marker-${evolutionState}` : ""}`;
      const rulesTooltipEntriesValue = rulesTooltipEntries(card);
      const rulesTooltipHtml = formatRulesTooltipHtml(rulesTooltipEntriesValue);
      const rulesTooltipTitle = rulesTooltipEntriesValue.map((entry) => entry.text).join("\n");
      const rulesTooltipAttrs = rulesTooltipTitle ? ` title="${escapeHtml(rulesTooltipTitle)}"` : "";
      const rulesTooltipElement = rulesTooltipHtml ? `<span class="card-rules-tooltip">${rulesTooltipHtml}</span>` : "";
      const canSendLiveCommand = snapshot.liveStateActive && card.pileId === "HandPile";
      const crackOverlayHtml = renderCardCrackOverlay(card);
      const commandAttrs = canSendLiveCommand
        ? ` data-live-command="play-card" data-card-id="${escapeHtml(card.cardId)}" data-card-guid="${escapeHtml(card.guid)}" data-pile-id="${escapeHtml(card.pileId)}" data-card-index="${card.index}" title="Play ${escapeHtml(cardDisplayName(card.cardId))}"`
        : "";

      return `
        <article class="card-row ${cardTypeClass(card)}${canSendLiveCommand ? " playable-card" : ""}${crackOverlayHtml ? " is-cracked-card" : ""}"${commandAttrs}>
          <div class="${cardTitleClass}">
            ${renderManaCost(card)}
            ${renderGemSlots(card)}
            ${evolutionMarker}
            <span class="card-name">${escapeHtml(cardDisplayName(card.cardId))}</span>
          </div>
          ${artPath ? `<img class="card-art" src="/${artPath}" alt="">` : ""}
          ${crackOverlayHtml}
          ${hasDescription ? `<p class="${descriptionClass}"${rulesTooltipAttrs}><span>${rulesTextHtml}${gemRulesHtml ? `<span class="gem-rules">${gemRulesHtml}</span>` : ""}</span>${rulesTooltipElement}</p>` : ""}
          ${statusLinesHtml}
        </article>
      `;
    }).join("")
    : `<p class="muted">${state.cardViewMode === "hand" ? "No cards in hand match the current filters." : "No cards match the current filters."}</p>`;

  requestAnimationFrame(fitCardTitles);
}

function clearPendingPlayCommand() {
  els.cards.querySelectorAll(".is-command-pending").forEach((card) => {
    card.classList.remove("is-command-pending");
    card.removeAttribute("aria-disabled");
  });
  state.pendingCommandId = "";
  state.pendingCommandStartedAt = 0;
}

async function sendPlayCardCommand(button) {
  const command = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: button.dataset.liveCommand || "play-card",
    dryRun: false,
    cardGuid: button.dataset.cardGuid || "",
    cardConfigId: button.dataset.cardId || "",
    pileId: button.dataset.pileId || "",
    index: Number(button.dataset.cardIndex),
  };
  if (state.pendingCommandId) return;

  state.pendingCommandId = command.id;
  state.pendingCommandStartedAt = Date.now();
  els.commandStatus.textContent = "";
  button.classList.add("is-command-pending");
  button.setAttribute("aria-disabled", "true");

  try {
    const response = await fetch("/api/live-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "Command was not accepted.");
    setTimeout(checkLiveCommandResult, 350);
  } catch (error) {
    els.commandStatus.textContent = error.message;
    clearPendingPlayCommand();
  }
}

async function checkLiveCommandResult() {
  if (!state.pendingCommandId) return;

  try {
    const response = await fetch("/api/live-command-result", { cache: "no-store" });
    const result = await response.json();
    if (!result.Id || result.Id !== state.pendingCommandId) {
      if (Date.now() - state.pendingCommandStartedAt < 5000) {
        setTimeout(checkLiveCommandResult, 250);
        return;
      }

      els.commandStatus.textContent = "Bridge did not confirm the card command.";
      clearPendingPlayCommand();
      return;
    }

    els.commandStatus.textContent = result.Ok && !result.InvocationError
      ? ""
      : result.Message || result.InvocationError || "Command failed.";
    console.info("Live bridge command result", result);
    clearPendingPlayCommand();
    await refresh();
  } catch (error) {
    if (Date.now() - state.pendingCommandStartedAt < 5000) {
      setTimeout(checkLiveCommandResult, 500);
      return;
    }

    els.commandStatus.textContent = error.message;
    clearPendingPlayCommand();
  }
}

function render(snapshot) {
  const sourceLabel = snapshot.liveStateActive ? "Live bridge" : "Save file";
  els.subtitle.textContent = `${sourceLabel}: ${snapshot.savePath}`;
  els.updatedAt.textContent = new Date(snapshot.lastModified).toLocaleTimeString();
  renderCosts(snapshot);
  renderCounts(snapshot);
  renderCards(snapshot);
  if (els.evolutionDialog.open) renderEvolutionRecipes();
}

async function loadArtMap() {
  try {
    const response = await fetch("/api/card-map", { cache: "no-store" });
    const data = await response.json();
    state.cardMap = data || {};
  } catch {
    state.cardMap = {};
  }
}

async function loadCardNames() {
  try {
    const response = await fetch("/api/card-names", { cache: "no-store" });
    const data = await response.json();
    state.cardNames = data || {};
  } catch {
    state.cardNames = {};
  }
}

async function loadCardText() {
  try {
    const response = await fetch("/api/card-text", { cache: "no-store" });
    const data = await response.json();
    state.cardText = data || {};
  } catch {
    state.cardText = {};
  }
}

async function loadTextMeta() {
  try {
    const response = await fetch("/api/text-meta", { cache: "no-store" });
    const data = await response.json();
    state.textMeta = data || {};
  } catch {
    state.textMeta = {};
  }
}

async function loadGemMap() {
  try {
    const response = await fetch("/api/gem-map", { cache: "no-store" });
    const data = await response.json();
    state.gemMap = data || {};
  } catch {
    state.gemMap = {};
  }
}

async function loadGemText() {
  try {
    const response = await fetch("/api/gem-text", { cache: "no-store" });
    const data = await response.json();
    state.gemText = data || {};
  } catch {
    state.gemText = {};
  }
}

async function loadEvolutions() {
  try {
    const response = await fetch("/assets/evolutions.json", { cache: "no-store" });
    const data = await response.json();
    state.evolutions = Array.isArray(data) ? data : [];
  } catch {
    state.evolutions = [];
  }
}

async function loadConfig() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    const config = await response.json();
    state.config = config;
    renderSetup(config);
  } catch {
    els.setupPanel.hidden = true;
  }
}

function renderSetup(config) {
  if (!config) return;
  const needsAttention = !config.hasSave || !config.hasGame || !config.hasArt || !config.hasCardCosts || !config.hasCardNames || !config.hasCardText || !config.hasGemMap || !config.hasGemText;
  els.setupPanel.hidden = Boolean(config.hideSetupPanel || state.setupHiddenThisSession || (!needsAttention && !window.vampireCrawlers));

  const parts = [
    config.hasGame ? "Game install found" : "Game install missing",
    config.hasSave ? "save found" : "save missing",
    config.hasArt ? "art cache ready" : "art cache missing",
    config.hasCardCosts ? "cost data ready" : "cost data missing",
    config.hasCardNames ? "name data ready" : "name data missing",
    config.hasCardText ? "text data ready" : "text data missing",
    config.hasGemMap ? "gem art ready" : "gem art missing",
    config.hasGemText ? "gem text ready" : "gem text missing",
  ];
  els.setupStatus.textContent = parts.join(", ");
  els.rebuildArt.hidden = !window.vampireCrawlers;
  els.hideSetupForever.hidden = !window.vampireCrawlers;
}

function showStartupSetup(status = {}) {
  if (!els.startupSetupDialog) return;
  els.startupSetupTitle.textContent = status.title || "Checking Setup";
  els.startupSetupMessage.textContent = status.message || "Preparing Vampire Crawlers Deck Tracker...";
  els.startupSetupDialog.classList.toggle("is-complete", status.state === "complete");
  els.startupSetupDialog.classList.toggle("is-error", status.state === "error" || status.state === "needs-input");
  if (els.startupSetupRetry) {
    els.startupSetupRetry.hidden = !(status.state === "error" || status.state === "needs-input");
  }
  if (!els.startupSetupDialog.open && typeof els.startupSetupDialog.showModal === "function") {
    els.startupSetupDialog.showModal();
  } else if (!els.startupSetupDialog.open) {
    els.startupSetupDialog.setAttribute("open", "");
  }
}

function hideStartupSetup() {
  if (!els.startupSetupDialog?.open) return;
  els.startupSetupDialog.close();
}

function appendStartupSetupLog(line) {
  if (!els.startupSetupLog) return;
  els.startupSetupLog.hidden = false;
  els.startupSetupLog.textContent += line;
  els.startupSetupLog.scrollTop = els.startupSetupLog.scrollHeight;
}

async function reloadLocalAssets() {
  await loadArtMap();
  await loadCardNames();
  await loadCardText();
  await loadTextMeta();
  await loadGemMap();
  await loadGemText();
  await loadConfig();
}

async function refresh() {
  try {
    const response = await fetch("/api/deck", { cache: "no-store" });
    const snapshot = await response.json();
    if (!response.ok) throw new Error(snapshot.error || "Unable to read save");
    stabilizeHandVisualStates(snapshot);
    applyCombatViewTransition(snapshot);
    state.snapshot = snapshot;
    render(snapshot);
  } catch (error) {
    els.subtitle.textContent = error.message;
  }
}

els.sortBy.addEventListener("change", (event) => {
  state.sortBy = event.target.value;
  if (state.snapshot) renderCards(state.snapshot);
});

els.frequencySort.addEventListener("change", (event) => {
  state.frequencySort = event.target.value;
  if (state.snapshot) renderCounts(state.snapshot);
});

els.cardViewMode.addEventListener("change", (event) => {
  state.cardViewMode = event.target.checked ? "hand" : "all";
  if (state.snapshot) renderCards(state.snapshot);
});

els.toggleSidebarColumn.addEventListener("click", () => {
  state.sidebarColumnHidden = !state.sidebarColumnHidden;
  updateSidebarColumnVisibility();
});

els.onlyComboCards.addEventListener("change", (event) => {
  state.onlyComboCards = event.target.checked;
  if (state.snapshot) renderCards(state.snapshot);
});

els.hideBreakingCards.addEventListener("change", (event) => {
  state.hideBreakingCards = event.target.checked;
  if (state.snapshot) renderCards(state.snapshot);
});

els.alwaysShowAttractorb.addEventListener("change", (event) => {
  state.alwaysShowAttractorb = event.target.checked;
  if (state.snapshot) renderCards(state.snapshot);
});

els.costs.addEventListener("click", (event) => {
  const target = event.target.closest("[data-cost-key]");
  if (!target || !els.costs.contains(target) || target.disabled) return;

  const costKey = target.dataset.costKey || "";
  state.costFilterKey = state.costFilterKey === costKey ? "" : costKey;
  if (state.snapshot) {
    renderCosts(state.snapshot);
    renderCards(state.snapshot);
  }
});

els.clearCostFilter.addEventListener("click", () => {
  if (!state.costFilterKey) return;
  state.costFilterKey = "";
  if (state.snapshot) {
    renderCosts(state.snapshot);
    renderCards(state.snapshot);
  }
});

els.cards.addEventListener("click", (event) => {
  const card = event.target.closest("[data-live-command]");
  if (!card || !els.cards.contains(card) || card.getAttribute("aria-disabled") === "true") return;
  sendPlayCardCommand(card);
});

els.evolutionsButton.addEventListener("click", () => {
  renderEvolutionRecipes();
  if (typeof els.evolutionDialog.showModal === "function") {
    els.evolutionDialog.showModal();
    return;
  }
  els.evolutionDialog.setAttribute("open", "");
});

els.evolutionClose.addEventListener("click", () => {
  els.evolutionDialog.close();
});

els.evolutionDialog.addEventListener("click", (event) => {
  if (event.target === els.evolutionDialog) els.evolutionDialog.close();
});

els.hideSetup.addEventListener("click", () => {
  state.setupHiddenThisSession = true;
  els.setupPanel.hidden = true;
});

window.addEventListener("resize", () => {
  if (state.snapshot) requestAnimationFrame(fitCardTitles);
});

async function loadInitialData() {
  await Promise.all([loadArtMap(), loadCardNames(), loadCardText(), loadTextMeta(), loadGemMap(), loadGemText(), loadEvolutions()]);
  await loadConfig();
  await refresh();
}

async function runStartupSetupFlow() {
  showStartupSetup({
    state: "checking",
    title: "Checking Setup",
    message: "Preparing Vampire Crawlers Deck Tracker...",
  });
  if (els.startupSetupLog) {
    els.startupSetupLog.hidden = true;
    els.startupSetupLog.textContent = "";
  }
  const result = await window.vampireCrawlers.runStartupSetup();
  if (!result?.ok) throw new Error(result?.message || "Setup did not finish.");
  await loadInitialData();
  setTimeout(hideStartupSetup, 500);
}

async function bootstrap() {
  if (window.vampireCrawlers?.runStartupSetup) {
    try {
      await runStartupSetupFlow();
    } catch (error) {
      showStartupSetup({
        state: "error",
        title: "Setup Needs Attention",
        message: error.message,
      });
      await loadInitialData().catch(() => {});
    }
  } else {
    await loadInitialData();
  }

  setInterval(refresh, 2000);
  setInterval(loadConfig, 10000);
}

if (window.vampireCrawlers) {
  els.updatePanel.hidden = false;

  window.vampireCrawlers.onUpdateStatus((status) => {
    els.updateStatus.textContent = status.message || "Update status changed.";
    els.checkUpdates.disabled = status.state === "checking" || status.state === "downloading";
    els.updatePanel.hidden = status.state === "idle";
  });

  els.checkUpdates.addEventListener("click", async () => {
    els.checkUpdates.disabled = true;
    try {
      await window.vampireCrawlers.checkForUpdates();
    } catch (error) {
      els.updateStatus.textContent = error.message;
    } finally {
      els.checkUpdates.disabled = false;
    }
  });

  window.vampireCrawlers.onSetupProgress((status) => {
    showStartupSetup(status);
  });

  els.startupSetupDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
  });

  els.startupSetupRetry?.addEventListener("click", async () => {
    els.startupSetupRetry.disabled = true;
    try {
      await runStartupSetupFlow();
    } catch (error) {
      showStartupSetup({
        state: "error",
        title: "Setup Needs Attention",
        message: error.message,
      });
    } finally {
      els.startupSetupRetry.disabled = false;
    }
  });

  window.vampireCrawlers.onSetupLog((line) => {
    state.setupHiddenThisSession = false;
    els.setupPanel.hidden = false;
    els.setupLog.hidden = false;
    els.setupLog.textContent += line;
    els.setupLog.scrollTop = els.setupLog.scrollHeight;
    appendStartupSetupLog(line);
  });

  async function rebuildLocalDataFromUi() {
    els.rebuildArt.disabled = true;
    els.setupLog.hidden = false;
    els.setupLog.textContent = "";
    try {
      await window.vampireCrawlers.rebuildArtCache();
      await reloadLocalAssets();
      if (state.snapshot) renderCards(state.snapshot);
    } catch (error) {
      els.setupLog.textContent += `\n${error.message}\n`;
    } finally {
      els.rebuildArt.disabled = false;
    }
  }

  els.hideSetupForever.addEventListener("click", async () => {
    const result = await window.vampireCrawlers.hideSetupPanelForever();
    if (!result?.hidden) return;
    state.config = { ...(state.config || {}), hideSetupPanel: true };
    els.setupPanel.hidden = true;
  });

  els.rebuildArt.addEventListener("click", rebuildLocalDataFromUi);
}

bootstrap();
