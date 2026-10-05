const assert = require("assert");
const scraper = require("./scrape_flight_price");

const card = scraper.parseFlightCard([
  "7:00 AM", "–", "8:40 AM", "Porter AirlinesAir Transat", "1 hr 40 min", "YYZ–LGA", "Nonstop",
  "87 kg CO2e", "CA$458", "round trip",
].join("\n"));
assert.equal(card.price_cad, 458);
assert.equal(card.origin_airport, "YYZ");
assert.equal(card.destination_airport, "LGA");
assert.equal(card.stops, 0);
assert.equal(card.duration_minutes, 100);
assert.equal(scraper.parseFlightCard("Flights from CA$299"), null, "generic from price must be rejected");

const candidate = scraper.parseGridCandidate("CA$394, cheapest price, Nov 7 to Nov 28", "2026-11-10", "2026-12-01");
assert.deepEqual(candidate, { depart_date: "2026-11-07", return_date: "2026-11-28", nights: 21, estimated_price_cad: 394 });
assert.equal(scraper.parseGridCandidate("CA$394, Nov 7 to Nov 10", "2026-11-10", "2026-11-10"), null, "short stays must be rejected");

const chinaLongStay = scraper.parseGridCandidate("CA$1,432, cheapest price, Nov 4 to Feb 25", "2026-11-03", "2027-02-20", 180);
assert.deepEqual(chinaLongStay, { depart_date: "2026-11-04", return_date: "2027-02-25", nights: 113, estimated_price_cad: 1432 });
assert.equal(scraper.parseGridCandidate("CA$1,432, Nov 4 to Feb 25", "2026-11-03", "2027-02-20"), null,
  "non-China searches must retain the 60-night default");
const chinaMaximumStay = scraper.parseGridCandidate("CA$1,432, Nov 4 to May 3", "2026-11-03", "2027-05-01", 180);
assert.equal(chinaMaximumStay.nights, 180, "China searches must accept exactly 180 nights");
assert.equal(scraper.parseGridCandidate("CA$1,432, Nov 4 to May 4", "2026-11-03", "2027-05-01", 180), null,
  "China searches must reject stays over 180 nights");

console.log("scraper parser tests passed");
