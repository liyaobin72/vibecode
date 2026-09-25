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

function queryCity() {
  const q = new URLSearchParams(window.location.search);
  return q.get("city") || "";
}

async function loadData() {
  const [en, zh, imageMap, flights] = await Promise.all([
    fetch("./travel_cities_en.json").then(r => r.json()),
    fetch("./travel_cities_zh.json").then(r => r.json()),
    fetch(`./assets/image-map.json?v=${Date.now()}`).then(r => r.json()).catch(() => ({})),
    fetch("/api/flights").then(r => r.json()).catch(() => ({ prices: {} }))
  ]);
  return { en, zh, imageMap, flights };
}

function cityImagePath(imageMap, slug) {
  return imageMap?.[slug]?.city || `./assets/images/cities/${slug}.jpg`;
}

function renderCity(enItem, zhItem, imageMap, flights, lang) {
  const c = lang === "zh" ? zhItem : enItem;
  const slug = slugify(enItem.city);
  const map = imageMap?.[slug] || { city: "", attractions: {}, foods: {} };
  const cityImg = cityImagePath(imageMap, slug);

  document.getElementById("langBtn").textContent = lang === "zh" ? "EN" : "中文";
  document.getElementById("backLink").textContent = lang === "zh" ? "← 返回城市列表" : "← Back to city list";
  document.title = `${c.city} - ${lang === "zh" ? "旅行指南" : "Travel Guide"}`;

  const root = document.getElementById("cityDetail");
  root.innerHTML = `
    <section class="city-hero">
      <img class="city-hero-img" src="${cityImg}" alt="${c.city}" />
      <div class="city-hero-shade"></div>
      <div class="city-hero-copy">
        <h1>${c.city}</h1>
        <p>${c.country_or_region} · ${c.tier}</p>
      </div>
    </section>

    <section class="section">
      <h2>${lang === "zh" ? "城市亮点" : "Highlights"}</h2>
      <p>${c.highlights}</p>
      <p><strong>${lang === "zh" ? "气候" : "Climate"}:</strong> ${c.climate}</p>
      <p><strong>${lang === "zh" ? "最佳时间" : "Best Time"}:</strong> ${c.best_time}</p>
    </section>

    <section class="section">
      <h2>${lang === "zh" ? "已核实航班优惠" : "Verified flight deal"}</h2>
      ${FlightUI.details(flights?.prices?.[slug] || {}, lang)}
    </section>

    <section class="section">
      <h2>${lang === "zh" ? "热门景点" : "Hotspots"}</h2>
      <div class="item-grid" id="hotspots"></div>
    </section>

    <section class="section">
      <h2>${lang === "zh" ? "推荐美食" : "Foods"}</h2>
      <div class="item-grid" id="foods"></div>
    </section>
  `;

  const hotRoot = document.getElementById("hotspots");
  c.attractions.forEach((a, i) => {
    const enName = enItem.attractions[i]?.name || a.name;
    const img = map.attractions?.[enName] || "";
    const el = document.createElement("article");
    el.className = "item";
    el.innerHTML = `
      <img src="${img}" alt="${a.name}" loading="lazy" onerror="this.style.display='none'" />
      <div class="txt">
        <h3>${a.name}</h3>
        <p class="small">${a.description}</p>
        <p class="small"><strong>${lang === "zh" ? "开放时间" : "Hours"}:</strong> ${a.opening_hours}</p>
        <p class="small"><strong>${lang === "zh" ? "门票" : "Ticket"}:</strong> ${a.ticket}</p>
      </div>
    `;
    hotRoot.appendChild(el);
  });

  const foodRoot = document.getElementById("foods");
  c.foods.forEach((food, i) => {
    const enFood = enItem.foods[i] || food;
    const img = map.foods?.[enFood] || "";
    const el = document.createElement("article");
    el.className = "item";
    el.innerHTML = `
      <img src="${img}" alt="${food}" loading="lazy" onerror="this.style.display='none'" />
      <div class="txt"><h3>${food}</h3></div>
    `;
    foodRoot.appendChild(el);
  });
}

(async function init() {
  const data = await loadData();
  const { en, zh, imageMap } = data;
  let flights = data.flights;
  const citySlug = queryCity();
  const idx = en.findIndex(c => slugify(c.city) === citySlug);
  if (idx < 0) {
    document.getElementById("cityDetail").innerHTML = "<p>City not found.</p>";
    return;
  }

  let lang = getLang();
  const render = () => renderCity(en[idx], zh[idx] || en[idx], imageMap, flights, lang);
  render();

  document.getElementById("langBtn").addEventListener("click", () => {
    lang = lang === "en" ? "zh" : "en";
    setLang(lang);
    render();
  });

  setInterval(async () => {
    flights = await fetch("/api/flights").then(r => r.json()).catch(() => flights);
    render();
  }, 60000);
})();
