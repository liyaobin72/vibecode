const fs = require("fs");
const path = require("path");

const root = __dirname;
const flightsPath = path.join(root, "assets", "flights.json");
const historyPath = path.join(root, "assets", "flight-history.json");

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

const flights = readJson(flightsPath, { prices: {} });
const history = readJson(historyPath, {});
const searchedAt = flights.updated_at || Math.floor(Date.now() / 1000);

for (const [slug, record] of Object.entries(flights.prices || {})) {
  if (!Number.isFinite(record.price_cad)) continue;
  history[slug] ||= [];
  const key = `${flights.depart_date}|${flights.return_date}|seed`;
  if (history[slug].some((entry) => entry.key === key)) continue;
  history[slug].push({
    key,
    city: slug,
    price_cad: record.price_cad,
    url: record.url,
    depart_date: flights.depart_date,
    return_date: flights.return_date,
    searched_at: searchedAt,
  });
}

fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf8");
console.log(`seeded=${Object.keys(history).length}`);
