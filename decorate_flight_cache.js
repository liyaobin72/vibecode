const fs = require("fs");
const path = require("path");

const cache = JSON.parse(fs.readFileSync(path.join(__dirname, "assets", "flights.json"), "utf8").replace(/^\uFEFF/, ""));
if (cache.schema_version !== 2) {
  console.error("Legacy cache detected. Run `node refresh_all_flight_prices.js` to create verified deal metadata.");
  process.exit(1);
}
console.log("No changes made: verified refreshes calculate comparable-history medians and deal labels atomically.");
