const state = {
  snapshot: null,
  cardMap: {},
  search: "",
  pile: "all",
  sortBy: "cost",
  config: null,
};

const els = {
  subtitle: document.querySelector("#subtitle"),
  totalCards: document.querySelector("#totalCards"),
  updatedAt: document.querySelector("#updatedAt"),
  search: document.querySelector("#search"),
  pileFilter: document.querySelector("#pileFilter"),
  sortBy: document.querySelector("#sortBy"),
  setupPanel: document.querySelector("#setupPanel"),
  setupStatus: document.querySelector("#setupStatus"),
  rebuildArt: document.querySelector("#rebuildArt"),
  setupLog: document.querySelector("#setupLog"),
  piles: document.querySelector("#piles"),
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
  const parsed = parseCardId(id);
  if (parsed) return parsed.name;
  return cleanId(id);
}

function cardTypeLabel(id) {
  const parsed = parseCardId(id);
  if (!parsed) return "";

  return {
    A: "Attack",
    S: "Support",
    B: "Buff",
    D: "Defence",
    M: "Utility",
  }[parsed.type] || parsed.type;
}

function pileRank(pileId) {
  return {
    HandPile: 0,
    DrawPile: 1,
    DiscardPile: 2,
    ComboPile: 3,
    DestroyPile: 4,
  }[pileId] ?? 20;
}

function costRank(cost) {
  return typeof cost === "number" ? cost : 99;
}

function cardMatches(card) {
  if (state.pile !== "all" && card.pileId !== state.pile) return false;
  if (!state.search) return true;

  const haystack = [
    card.cardId,
    card.baseId,
    card.pileId,
    card.guid,
    ...card.gems,
  ].join(" ").toLowerCase();

  return haystack.includes(state.search.toLowerCase());
}

function sortCards(cards) {
  const sorted = [...cards];
  sorted.sort((a, b) => {
    if (state.sortBy === "cost") {
      return costRank(a.cost) - costRank(b.cost)
        || a.cardId.localeCompare(b.cardId)
        || pileRank(a.pileId) - pileRank(b.pileId)
        || a.index - b.index;
    }
    if (state.sortBy === "name") return a.cardId.localeCompare(b.cardId);
    if (state.sortBy === "base") return a.baseId.localeCompare(b.baseId) || a.cardId.localeCompare(b.cardId);
    if (state.sortBy === "gems") return b.gems.length - a.gems.length || a.cardId.localeCompare(b.cardId);
    return pileRank(a.pileId) - pileRank(b.pileId) || a.index - b.index;
  });
  return sorted;
}

function renderPiles(snapshot) {
  els.piles.innerHTML = snapshot.piles
    .map((pile) => `
      <div class="pile-row">
        <strong>${pile.pileId}</strong>
        <span class="badge">${pile.count}</span>
      </div>
    `)
    .join("");

  const options = [`<option value="all">All piles</option>`]
    .concat(snapshot.piles.map((pile) => `<option value="${pile.pileId}">${pile.pileId}</option>`));
  els.pileFilter.innerHTML = options.join("");
  els.pileFilter.value = state.pile;
}

function renderCounts(snapshot) {
  els.counts.innerHTML = snapshot.counts
    .map((entry) => `
      <div class="count-row">
        <span>${cleanId(entry.cardId)}</span>
        <span class="badge">${entry.count}</span>
      </div>
    `)
    .join("");
}

function renderCosts(snapshot) {
  els.costs.innerHTML = (snapshot.costCounts || [])
    .map((entry) => `
      <div class="count-row">
        <span>${formatCost(entry.cost)}</span>
        <span class="badge">${entry.count}</span>
      </div>
    `)
    .join("");
}

function formatCost(cost) {
  if (typeof cost === "number") return `${cost} mana`;
  if (cost === "FCC") return "Crawler";
  return cost;
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

      return `
        <article class="card-row">
          <div class="card-title">
            <span class="tag good">${formatCost(card.cost)}</span>
            <span>${cardDisplayName(card.cardId)}</span>
          </div>
          ${artPath ? `<img class="card-art" src="/${artPath}" alt="">` : ""}
          <div class="card-meta">
            ${cardTypeLabel(card.cardId) ? `<span class="tag">${cardTypeLabel(card.cardId)}</span>` : ""}
            <span class="tag">${card.pileId}</span>
            <span class="tag">Base: ${cardDisplayName(card.baseId)}</span>
            <span class="tag">#${card.index + 1}</span>
          </div>
          ${card.gems.length ? `<div class="tags">${card.gems.map((gem) => `<span class="tag good">${cleanId(gem)}</span>`).join("")}</div>` : ""}
          ${flags.length ? `<div class="tags">${flags.map((flag) => `<span class="tag">${flag}</span>`).join("")}</div>` : ""}
        </article>
      `;
    }).join("")
    : `<p class="muted">No cards match the current filters.</p>`;
}

function render(snapshot) {
  els.subtitle.textContent = snapshot.savePath;
  els.totalCards.textContent = `${snapshot.totalCards} cards`;
  els.updatedAt.textContent = new Date(snapshot.lastModified).toLocaleTimeString();
  renderPiles(snapshot);
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
  const needsAttention = !config.hasSave || !config.hasGame || !config.hasArt || !config.hasCardCosts;
  els.setupPanel.hidden = !needsAttention && !window.vampireCrawlers;

  const parts = [
    config.hasGame ? "Game install found" : "Game install missing",
    config.hasSave ? "save found" : "save missing",
    config.hasArt ? "art cache ready" : "art cache missing",
    config.hasCardCosts ? "cost data ready" : "cost data missing",
  ];
  els.setupStatus.textContent = parts.join(", ");
  els.rebuildArt.hidden = !window.vampireCrawlers;
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

els.pileFilter.addEventListener("change", (event) => {
  state.pile = event.target.value;
  if (state.snapshot) renderCards(state.snapshot);
});

els.sortBy.addEventListener("change", (event) => {
  state.sortBy = event.target.value;
  if (state.snapshot) renderCards(state.snapshot);
});

loadArtMap().then(refresh);
loadConfig();
setInterval(refresh, 2000);
setInterval(loadConfig, 10000);

if (window.vampireCrawlers) {
  window.vampireCrawlers.onSetupLog((line) => {
    els.setupLog.hidden = false;
    els.setupLog.textContent += line;
    els.setupLog.scrollTop = els.setupLog.scrollHeight;
  });

  els.rebuildArt.addEventListener("click", async () => {
    els.rebuildArt.disabled = true;
    els.setupLog.hidden = false;
    els.setupLog.textContent = "Rebuilding local art and cost data...\n";
    try {
      await window.vampireCrawlers.rebuildArtCache();
      await loadArtMap();
      await loadConfig();
      if (state.snapshot) renderCards(state.snapshot);
    } catch (error) {
      els.setupLog.textContent += `\n${error.message}\n`;
    } finally {
      els.rebuildArt.disabled = false;
    }
  });
}
