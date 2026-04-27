const state = {
  snapshot: null,
  cardMap: {},
  cardNames: {},
  cardText: {},
  gemMap: {},
  gemText: {},
  search: "",
  sortBy: "cost",
  frequencySort: "name",
  config: null,
  setupHiddenThisSession: false,
};

const HIDDEN_GEM_RULE_IDS = new Set([
  "GemConfig_DoubleDamage",
  "GemConfig_Evolve",
]);

const els = {
  subtitle: document.querySelector("#subtitle"),
  totalCards: document.querySelector("#totalCards"),
  updatedAt: document.querySelector("#updatedAt"),
  search: document.querySelector("#search"),
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
  costs: document.querySelector("#costs"),
  counts: document.querySelector("#counts"),
  cards: document.querySelector("#cards"),
};

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
  if (card?.cardId === "Card_S_2_Bracer") {
    return highlightRuleValues(text, /(?<![\w%])(XX%?|YY%?|Z|\d+%?)(?![\w%])/g);
  }
  return highlightRuleValues(text, /(?<![\w%])(XX%?|YY%?|Z|\d+%?|Area|Crit|Disarm|Duration|Hand|Knockback|Might)(?![\w%])/g);
}

function formatGemRulesHtml(gems) {
  return (gems || [])
    .map((gem) => {
      if (HIDDEN_GEM_RULE_IDS.has(gem)) return "";
      const text = highlightRuleValues(
        escapeHtml(punctuateSentence(gemRulesText(gem))),
        /(?<![\w%])(XX%?|YY%?|Z|\d+%?)(?![\w%])/g,
      );
      const className = gem === "GemConfig_Armor" ? "gem-rule gem-rule-card-text" : "gem-rule";
      return `<span class="${className}">${text}</span>`;
    })
    .join("");
}

function highlightRuleValues(text, pattern) {
  return text.replace(pattern, `<span class="rules-value">$1</span>`);
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
  return state.gemText[id] || gemDisplayName(id);
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

function cardRulesText(id) {
  return state.cardText[id] || "";
}

function cardTypeClass(card) {
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

function costRank(cost) {
  return typeof cost === "number" ? cost : 99;
}

function cardMatches(card) {
  if (!state.search) return true;

  const haystack = [
    card.cardId,
    card.baseId,
    cardDisplayName(card.cardId),
    card.guid,
    ...card.gems,
    ...card.gems.map(gemDisplayName),
  ].join(" ").toLowerCase();

  return haystack.includes(state.search.toLowerCase());
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
    if (state.sortBy === "base") return a.baseId.localeCompare(b.baseId) || a.cardId.localeCompare(b.cardId);
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
  const manaCosts = costCounts.filter(isManaCostEntry);
  const otherCosts = costCounts.filter((entry) => !isManaCostEntry(entry));

  els.costs.innerHTML = [
    renderCostHistogram(manaCosts),
    renderCostRows(otherCosts),
  ].filter(Boolean).join("");
}

function isManaCostEntry(entry) {
  if (!entry) return false;
  if (entry.kind === "mana") return true;
  return typeof entry.cost === "number" && !String(entry.key || "").startsWith("crawler:");
}

function renderCostHistogram(entries) {
  if (!entries.length) return "";

  const costs = entries
    .map((entry) => entry.cost)
    .filter((cost) => typeof cost === "number");
  const minCost = Math.min(0, ...costs);
  const maxCost = Math.max(0, ...costs);
  const entriesByCost = new Map(entries.map((entry) => [entry.cost, entry]));
  const curveEntries = Array.from({ length: maxCost - minCost + 1 }, (_, index) => {
    const cost = minCost + index;
    return entriesByCost.get(cost) || {
      key: `mana:${cost}`,
      kind: "mana",
      cost,
      label: String(cost),
      count: 0,
    };
  });
  const maxCount = Math.max(...curveEntries.map((entry) => entry.count || 0), 1);

  return `
    <div class="cost-histogram" aria-label="Mana cost curve">
      ${curveEntries.map((entry) => {
        const count = entry.count || 0;
        const height = count ? Math.max(12, Math.round((count / maxCount) * 100)) : 0;

        return `
          <div class="cost-bar-group" title="${formatCostEntry(entry)}: ${count}">
            <div class="cost-bar-shell">
              <div class="cost-bar${count ? "" : " is-empty"}" style="height: ${height}%">
                <span>${count}</span>
              </div>
            </div>
            <div class="cost-bar-label">${formatCostEntry(entry)}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderCostRows(entries) {
  return entries
    .map((entry) => `
      <div class="count-row">
        <span>${formatCostEntry(entry)}</span>
        <span class="badge">${entry.count}</span>
      </div>
    `)
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

function renderCards(snapshot) {
  const cards = sortCards(snapshot.cards.filter(cardMatches));

  els.cards.innerHTML = cards.length
    ? cards.map((card) => {
      const flags = [
        card.temporary ? "Temporary" : "",
        card.broken ? "Broken" : "",
        card.copyWithDestroy ? "Destroy copy" : "",
        card.limitBreaks ? `Limit +${card.limitBreaks}` : "",
        card.manaModifier ? `Mana ${card.manaModifier}` : "",
      ].filter(Boolean);
      const artPath = state.cardMap[card.cardId] || state.cardMap[card.baseId] || "";
      const rulesText = cardRulesText(card.cardId) || cardRulesText(card.baseId);
      const gemRulesTextValue = card.gems.map((gem) => punctuateSentence(gemRulesText(gem))).filter(Boolean).join("\n");
      const safeRulesText = escapeHtml([rulesText, gemRulesTextValue].filter(Boolean).join("\n"));
      const rulesTextHtml = formatRulesTextHtml(rulesText, card);
      const gemRulesHtml = formatGemRulesHtml(card.gems);
      const hasDescription = Boolean(rulesText || gemRulesHtml);

      return `
        <article class="card-row ${cardTypeClass(card)}"${hasDescription ? ` title="${safeRulesText}"` : ""}>
          <div class="card-title">
            <span class="mana-cost" title="${formatCost(card.cost)}">${formatCostSymbol(card.cost)}</span>
            ${renderGemSlots(card)}
            <span class="card-name">${escapeHtml(cardDisplayName(card.cardId))}</span>
          </div>
          ${artPath ? `<img class="card-art" src="/${artPath}" alt="">` : ""}
          ${hasDescription ? `<p class="card-description"><span>${rulesTextHtml}${gemRulesHtml ? `<span class="gem-rules">${gemRulesHtml}</span>` : ""}</span></p>` : ""}
          ${flags.length ? `<div class="tags">${flags.map((flag) => `<span class="tag">${flag}</span>`).join("")}</div>` : ""}
        </article>
      `;
    }).join("")
    : `<p class="muted">No cards match the current filters.</p>`;

  requestAnimationFrame(fitCardTitles);
}

function render(snapshot) {
  els.subtitle.textContent = snapshot.savePath;
  els.totalCards.textContent = `${snapshot.totalCards} cards`;
  els.updatedAt.textContent = new Date(snapshot.lastModified).toLocaleTimeString();
  renderCosts(snapshot);
  renderCounts(snapshot);
  renderCards(snapshot);
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

async function refresh() {
  try {
    const response = await fetch("/api/deck", { cache: "no-store" });
    const snapshot = await response.json();
    if (!response.ok) throw new Error(snapshot.error || "Unable to read save");
    state.snapshot = snapshot;
    render(snapshot);
  } catch (error) {
    els.subtitle.textContent = error.message;
  }
}

els.search.addEventListener("input", (event) => {
  state.search = event.target.value.trim();
  if (state.snapshot) renderCards(state.snapshot);
});

els.sortBy.addEventListener("change", (event) => {
  state.sortBy = event.target.value;
  if (state.snapshot) renderCards(state.snapshot);
});

els.frequencySort.addEventListener("change", (event) => {
  state.frequencySort = event.target.value;
  if (state.snapshot) renderCounts(state.snapshot);
});

els.hideSetup.addEventListener("click", () => {
  state.setupHiddenThisSession = true;
  els.setupPanel.hidden = true;
});

window.addEventListener("resize", () => {
  if (state.snapshot) requestAnimationFrame(fitCardTitles);
});

Promise.all([loadArtMap(), loadCardNames(), loadCardText(), loadGemMap(), loadGemText()]).then(refresh);
loadConfig();
setInterval(refresh, 2000);
setInterval(loadConfig, 10000);

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

  window.vampireCrawlers.onSetupLog((line) => {
    state.setupHiddenThisSession = false;
    els.setupPanel.hidden = false;
    els.setupLog.hidden = false;
    els.setupLog.textContent += line;
    els.setupLog.scrollTop = els.setupLog.scrollHeight;
  });

  async function rebuildLocalDataFromUi() {
    els.rebuildArt.disabled = true;
    els.setupLog.hidden = false;
    els.setupLog.textContent = "";
    try {
      await window.vampireCrawlers.rebuildArtCache();
      await loadArtMap();
      await loadCardNames();
      await loadCardText();
      await loadGemMap();
      await loadGemText();
      await loadConfig();
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
