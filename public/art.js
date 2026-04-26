const state = {
  items: [],
  search: "",
  sizeFilter: "large",
  sortBy: "area",
};

const els = {
  subtitle: document.querySelector("#subtitle"),
  totalArt: document.querySelector("#totalArt"),
  search: document.querySelector("#search"),
  sizeFilter: document.querySelector("#sizeFilter"),
  sortBy: document.querySelector("#sortBy"),
  artGrid: document.querySelector("#artGrid"),
};

function matches(item) {
  if (!item.path) return false;
  if (state.sizeFilter === "large" && Math.max(item.width, item.height) < 80) return false;
  if (state.sizeFilter === "wide" && item.width <= item.height * 1.25) return false;
  if (state.sizeFilter === "square" && Math.abs(item.width - item.height) > Math.max(item.width, item.height) * 0.18) return false;
  if (!state.search) return true;

  const haystack = `${item.bundle} ${item.pathId} ${item.width}x${item.height} ${item.name}`.toLowerCase();
  return haystack.includes(state.search.toLowerCase());
}

function sorted(items) {
  const copy = [...items];
  copy.sort((a, b) => {
    if (state.sortBy === "bundle") return a.bundle.localeCompare(b.bundle) || b.width * b.height - a.width * a.height;
    if (state.sortBy === "shape") return b.width / b.height - a.width / a.height;
    return b.width * b.height - a.width * a.height;
  });
  return copy;
}

function render() {
  const items = sorted(state.items.filter(matches)).slice(0, 1200);
  els.totalArt.textContent = `${state.items.filter((item) => item.path).length} sprites`;
  els.subtitle.textContent = `${items.length} shown. Use path ID or image path when building card-map.json.`;
  els.artGrid.innerHTML = items.map((item) => `
    <article class="art-tile">
      <img src="/${item.path}" loading="lazy" alt="">
      <div class="art-meta">
        <strong>${item.width}x${item.height}</strong>
        <span>${item.pathId}</span>
        <span>${item.bundle}</span>
        <code>${item.path}</code>
      </div>
    </article>
  `).join("");
}

async function load() {
  const response = await fetch("/api/art");
  const data = await response.json();
  state.items = data.manifest || [];
  render();
}

els.search.addEventListener("input", (event) => {
  state.search = event.target.value.trim();
  render();
});

els.sizeFilter.addEventListener("change", (event) => {
  state.sizeFilter = event.target.value;
  render();
});

els.sortBy.addEventListener("change", (event) => {
  state.sortBy = event.target.value;
  render();
});

load();
