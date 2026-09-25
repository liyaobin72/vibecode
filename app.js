const LANG_KEY = "travel_lang";

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function getLang() {
  return localStorage.getItem(LANG_KEY) || "en";
}

function setLang(lang) {
  localStorage.setItem(LANG_KEY, lang);
}

async function loadData() {
  const [en, zh, imageMap, flights] = await Promise.all([
    fetch("./travel_cities_en.json").then(r => r.json()),
    fetch("./travel_cities_zh.json").then(r => r.json()),
    fetch(`./assets/image-map.json?v=${Date.now()}`).then(r => r.json()).catch(() => ({})),
    loadFlights()
  ]);
  return { en, zh, imageMap, flights };
}

function cityImagePath(imageMap, slug) {
  return imageMap?.[slug]?.city || `assets/images/cities/${slug}.jpg`;
}

async function loadFlights() {
  return fetch("/api/flights").then(r => r.json()).catch(() => ({ prices: {} }));
}

function textMap(lang) {
  return lang === "zh"
    ? { title: "旅行指南", subtitle: "从灵感到出发，发现下一座值得奔赴的城市", switchTo: "EN" }
    : { title: "Travel Guide", subtitle: "From inspiration to departure, find the next city worth the journey", switchTo: "中文" };
}

function pairData(en, zh) {
  return en.map((item, i) => ({ en: item, zh: zh[i] || item }));
}

function render(pairs, imageMap, flights, lang) {
  const t = textMap(lang);
  document.getElementById("title").textContent = t.title;
  document.getElementById("subtitle").textContent = t.subtitle;
  document.getElementById("langBtn").textContent = t.switchTo;

  const grouped = new Map();
  for (const p of pairs) {
    const key = p.en.tier;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(p);
  }

  const root = document.getElementById("tierContainer");
  root.innerHTML = "";

  for (const [_, items] of grouped) {
    const tierLabel = lang === "zh" ? items[0].zh.tier : items[0].en.tier;
    const block = document.createElement("section");
    block.className = "tier-block";

    const h = document.createElement("h2");
    h.className = "tier-title";
    h.textContent = tierLabel;
    block.appendChild(h);

    const grid = document.createElement("div");
    grid.className = "grid";

    for (const p of items) {
      const c = lang === "zh" ? p.zh : p.en;
      const slug = slugify(p.en.city);
      const cityImg = cityImagePath(imageMap, slug);
      const f = flights?.prices?.[slug] || {};
      const exactUrl = f.exact_url || f.url;
      const flightSummary = FlightUI.summary(f, lang);
      const flightLine = exactUrl && f.verification_status === "verified"
        ? `<a class="flight-link ${f.is_deal ? "flight-link-deal" : ""}" href="${FlightUI.escapeHtml(exactUrl)}" target="_blank" rel="noopener noreferrer">${flightSummary}</a>`
        : flightSummary;

      const card = document.createElement("article");
      card.className = `card ${f.is_deal ? "deal-card" : ""}`;
      card.innerHTML = `
        <a class="image-link" href="./city.html?city=${encodeURIComponent(slug)}">
          <img src="${cityImg}" alt="${c.city}" loading="lazy" />
        </a>
        <div class="card-content">
          <h3><a class="city-link" href="./city.html?city=${encodeURIComponent(slug)}">${c.city}</a></h3>
          <div class="meta">${c.country_or_region}</div>
          ${flightLine}
          <p class="small">${c.highlights}</p>
        </div>
      `;
      grid.appendChild(card);
    }

    block.appendChild(grid);
    root.appendChild(block);
  }
}

(async function init() {
  let { en, zh, imageMap, flights } = await loadData();
  const pairs = pairData(en, zh);
  let lang = getLang();
  render(pairs, imageMap, flights, lang);

  document.getElementById("langBtn").addEventListener("click", () => {
    lang = lang === "en" ? "zh" : "en";
    setLang(lang);
    render(pairs, imageMap, flights, lang);
  });

  setInterval(async () => {
    flights = await loadFlights();
    render(pairs, imageMap, flights, lang);
  }, 60000);
})();
