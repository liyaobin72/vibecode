const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const EDGE_PATH = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PAGE_TIMEOUT_MS = 45_000;
const RESULTS_WAIT_MS = 18_000;
const MIN_PRICE_CAD = 100;
const MAX_PRICE_CAD = 20_000;

function parseMoney(value) {
  const match = String(value || "").match(/(?:CA\$|C\$)\s*([0-9][0-9,]*)/i);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) && amount >= MIN_PRICE_CAD && amount <= MAX_PRICE_CAD ? amount : null;
}

function parseDuration(value) {
  const match = String(value || "").match(/^(?:(\d+)\s*hr)?\s*(?:(\d+)\s*min)?$/i);
  if (!match || (!match[1] && !match[2])) return null;
  return Number(match[1] || 0) * 60 + Number(match[2] || 0);
}

function parseStops(value) {
  if (/nonstop/i.test(value || "")) return 0;
  const match = String(value || "").match(/(\d+)\s+stops?/i);
  return match ? Number(match[1]) : null;
}

function parseFlightCard(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const joined = lines.join("\n");
  const priceMatch = joined.match(/(?:CA\$|C\$)\s*([0-9][0-9,]*)\s*\n?round trip\b/i);
  const routeMatch = joined.match(/\b([A-Z]{3})\s*[–—-]\s*([A-Z]{3})\b/);
  const durationIndex = lines.findIndex((line) => parseDuration(line) !== null);
  const stopsLine = lines.find((line) => /^(?:nonstop|\d+\s+stops?)$/i.test(line));
  const times = lines.filter((line) => /\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i.test(line)).slice(0, 2);
  if (!priceMatch || !routeMatch || durationIndex < 0 || !stopsLine || times.length < 2) return null;
  const price = Number(priceMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(price) || price < MIN_PRICE_CAD || price > MAX_PRICE_CAD) return null;
  const airlineRaw = lines[durationIndex - 1] || "";
  const airline = airlineRaw.split(/Operated by/i)[0].trim().replace(/([a-z])([A-Z])/g, "$1, $2") || null;
  return {
    price_cad: price,
    origin_airport: routeMatch[1],
    destination_airport: routeMatch[2],
    departure_time: times[0],
    arrival_time: times[1],
    airline,
    stops: parseStops(stopsLine),
    duration_minutes: parseDuration(lines[durationIndex]),
    duration_text: lines[durationIndex],
    raw_text: joined,
  };
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseIso(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inferGridDate(monthName, day, referenceIso) {
  const reference = parseIso(referenceIso);
  if (!reference) return null;
  const parsedMonth = new Date(`${monthName} 1, 2000 00:00:00 UTC`);
  if (Number.isNaN(parsedMonth.getTime())) return null;
  const month = parsedMonth.getUTCMonth();
  const candidates = [-1, 0, 1].map((offset) => new Date(Date.UTC(reference.getUTCFullYear() + offset, month, Number(day))));
  candidates.sort((a, b) => Math.abs(a - reference) - Math.abs(b - reference));
  return isoDate(candidates[0]);
}

function parseGridCandidate(label, departReference, returnReference, maxStayNights = 60) {
  const match = String(label || "").match(/(?:CA\$|C\$)\s*([0-9][0-9,]*).*?\b([A-Z][a-z]{2})\s+(\d{1,2})\s+to\s+([A-Z][a-z]{2})\s+(\d{1,2})/i);
  if (!match) return null;
  const price = Number(match[1].replace(/,/g, ""));
  const departDate = inferGridDate(match[2], match[3], departReference);
  let returnDate = inferGridDate(match[4], match[5], returnReference);
  if (!departDate || !returnDate || !Number.isFinite(price)) return null;
  if (returnDate <= departDate) {
    const adjusted = parseIso(returnDate);
    adjusted.setUTCFullYear(adjusted.getUTCFullYear() + 1);
    returnDate = isoDate(adjusted);
  }
  const nights = Math.round((parseIso(returnDate) - parseIso(departDate)) / 86_400_000);
  if (nights < 14 || nights > maxStayNights || price < MIN_PRICE_CAD || price > MAX_PRICE_CAD) return null;
  return { depart_date: departDate, return_date: returnDate, nights, estimated_price_cad: price };
}

function exactSearchUrl(city, departDate, returnDate, destinationAirport) {
  const format = (value) => {
    const date = parseIso(value);
    return `${date.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${date.getUTCDate()} ${date.getUTCFullYear()}`;
  };
  const destination = destinationAirport ? `${city} (${destinationAirport})` : city;
  const query = `Flights from Toronto (YYZ) to ${destination} ${format(departDate)} return ${format(returnDate)}`;
  return `https://www.google.com/travel/flights/search?${new URLSearchParams({ q: query, curr: "CAD", hl: "en" }).toString()}`;
}

async function waitForCards(page) {
  await page.locator("li.pIav2d").first().waitFor({ state: "visible", timeout: RESULTS_WAIT_MS });
}

async function cardData(page) {
  const texts = await page.locator("li.pIav2d").allInnerTexts();
  return texts.map((text, index) => ({ index, parsed: parseFlightCard(text) })).filter((item) => item.parsed);
}

function matchesLeg(card, origin, allowedDestinations) {
  return card.origin_airport === origin && allowedDestinations.includes(card.destination_airport);
}

function sameLeg(card, expected) {
  if (!expected) return true;
  return card.origin_airport === expected.origin_airport && card.destination_airport === expected.destination_airport &&
    card.departure_time === expected.departure_time && card.arrival_time === expected.arrival_time &&
    card.duration_minutes === expected.duration_minutes && card.stops === expected.stops;
}

function practicalScore(card) {
  return card.price_cad + (card.stops || 0) * 90 + (card.duration_minutes || 0) * 0.08;
}

async function discovery(page, request) {
  const searchCity = request.search_city || request.city;
  const url = exactSearchUrl(searchCity, request.depart_date, request.return_date, request.destination_airport);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
  await waitForCards(page);
  const dateGrid = page.getByRole("button", { name: "Date grid", exact: true });
  await dateGrid.waitFor({ state: "visible", timeout: RESULTS_WAIT_MS });
  await dateGrid.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: RESULTS_WAIT_MS });
  await page.waitForTimeout(2500);
  const labels = await dialog.locator("button, [role='button'], [aria-label]").evaluateAll((nodes) =>
    [...new Set(nodes.map((node) => node.getAttribute("aria-label") || node.innerText).filter(Boolean))]);
  const candidates = labels.map((label) =>
    parseGridCandidate(label, request.depart_date, request.return_date, request.max_stay_nights || 60)).filter(Boolean)
    .sort((a, b) => a.estimated_price_cad - b.estimated_price_cad || a.nights - b.nights);
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.depart_date}|${candidate.return_date}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push({ ...candidate, search_url: exactSearchUrl(searchCity, candidate.depart_date, candidate.return_date, request.destination_airport) });
    }
  }
  return {
    status: unique.length ? "ok" : "error",
    source: "google_flights_date_grid",
    candidates: unique.slice(0, request.limit || 8),
    rejection_reason: unique.length ? null : "date_grid_had_no_parseable_candidates",
    diagnostic_labels: unique.length ? undefined : labels.slice(0, 12),
  };
}

function dateMarker(value) {
  const date = parseIso(value);
  return `${date.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${date.getUTCDate()}`;
}

function priceInsight(bodyText) {
  if (/prices? (?:are|is) currently low/i.test(bodyText)) return "low";
  if (/prices? (?:are|is) (?:currently )?typical/i.test(bodyText)) return "typical";
  if (/prices? (?:are|is) currently high/i.test(bodyText)) return "high";
  return null;
}

async function verify(page, request) {
  const searchUrl = request.search_url || exactSearchUrl(request.search_city || request.city, request.depart_date, request.return_date, request.destination_airport);
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
  await waitForCards(page);
  const origin = request.origin_airport || "YYZ";
  const allowed = request.allowed_destination_airports || [request.destination_airport];
  let outboundChoices = (await cardData(page)).filter(({ parsed }) => matchesLeg(parsed, origin, allowed));
  if (request.expected?.outbound) outboundChoices = outboundChoices.filter(({ parsed }) => sameLeg(parsed, request.expected.outbound));
  outboundChoices.sort((a, b) => practicalScore(a.parsed) - practicalScore(b.parsed));
  if (!outboundChoices.length) throw new Error("no_matching_outbound_itinerary");
  const outboundChoice = outboundChoices[0];
  await page.locator("li.pIav2d").nth(outboundChoice.index).click();
  await page.waitForTimeout(1200);
  await waitForCards(page);

  let returnChoices = (await cardData(page)).filter(({ parsed }) => allowed.includes(parsed.origin_airport) && parsed.destination_airport === origin);
  if (request.expected?.return) returnChoices = returnChoices.filter(({ parsed }) => sameLeg(parsed, request.expected.return));
  if (request.expected?.price_cad) returnChoices = returnChoices.filter(({ parsed }) => parsed.price_cad === request.expected.price_cad);
  returnChoices.sort((a, b) => practicalScore(a.parsed) - practicalScore(b.parsed));
  if (!returnChoices.length) throw new Error("no_matching_return_itinerary");
  const returnChoice = returnChoices[0];
  await page.locator("li.pIav2d").nth(returnChoice.index).click();
  await page.waitForURL(/\/travel\/flights\/booking/, { timeout: RESULTS_WAIT_MS });
  await page.getByText("Selected flights", { exact: true }).waitFor({ state: "visible", timeout: RESULTS_WAIT_MS }).catch(() => null);
  await page.waitForTimeout(1200);
  const bodyText = await page.locator("body").innerText({ timeout: RESULTS_WAIT_MS });
  const exactUrl = page.url();
  const price = returnChoice.parsed.price_cad;
  const routeVerified = bodyText.includes(`${outboundChoice.parsed.origin_airport}–${outboundChoice.parsed.destination_airport}`) &&
    bodyText.includes(`${returnChoice.parsed.origin_airport}–${returnChoice.parsed.destination_airport}`);
  const datesVerified = bodyText.includes(dateMarker(request.depart_date)) && bodyText.includes(dateMarker(request.return_date));
  const currencyVerified = /Currency\s*CAD/i.test(bodyText) || /[?&]curr=CAD\b/.test(exactUrl);
  if (!routeVerified) throw new Error("booking_summary_route_mismatch");
  if (!datesVerified) throw new Error("booking_summary_date_mismatch");
  if (!currencyVerified) throw new Error("booking_summary_currency_mismatch");
  if (request.expected?.price_cad && price !== request.expected.price_cad) throw new Error("price_changed_during_recheck");

  const airlines = [...new Set([outboundChoice.parsed.airline, returnChoice.parsed.airline].filter(Boolean))];
  return {
    status: "verified", verification_status: "verified", price_cad: price, currency: "CAD", origin_airport: origin,
    destination_airports: [...new Set([outboundChoice.parsed.destination_airport, returnChoice.parsed.origin_airport])],
    depart_date: request.depart_date, return_date: request.return_date,
    nights: Math.round((parseIso(request.return_date) - parseIso(request.depart_date)) / 86_400_000),
    airlines, airline: airlines.join(", ") || null,
    stops: { outbound: outboundChoice.parsed.stops, return: returnChoice.parsed.stops },
    journey_duration_minutes: { outbound: outboundChoice.parsed.duration_minutes, return: returnChoice.parsed.duration_minutes },
    journey_duration: { outbound: outboundChoice.parsed.duration_text, return: returnChoice.parsed.duration_text },
    cabin_fare: "Economy (including Basic)", baggage: null,
    google_price_insight: priceInsight(bodyText), search_url: searchUrl, url: exactUrl, exact_url: exactUrl,
    outbound: outboundChoice.parsed, return: returnChoice.parsed,
  };
}

async function saveDiagnostic(page, request) {
  if (!request.diagnostic_dir) return null;
  const safeSlug = String(request.slug || "unknown").replace(/[^a-z0-9-]/gi, "-");
  fs.mkdirSync(request.diagnostic_dir, { recursive: true });
  const target = path.join(request.diagnostic_dir, `${safeSlug}-${request.action || "scrape"}-${Date.now()}.png`);
  await page.screenshot({ path: target, fullPage: true }).catch(() => null);
  return target;
}

async function run(request) {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE_PATH, args: ["--disable-blink-features=AutomationControlled"] });
  const context = await browser.newContext({
    locale: "en-CA", timezoneId: "America/Toronto",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  try {
    if (request.action === "discover") return await discovery(page, request);
    if (request.action === "verify" || request.action === "recheck") return await verify(page, request);
    throw new Error("unsupported_action");
  } catch (error) {
    return { status: "error", verification_status: "rejected", rejection_reason: error.message, screenshot: await saveDiagnostic(page, request) };
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  let request = {};
  try { request = JSON.parse(process.argv[2] || "{}"); }
  catch (error) { process.stdout.write(JSON.stringify({ status: "error", error: "invalid_request_json" })); process.exit(0); }
  run(request).then((result) => process.stdout.write(JSON.stringify(result)))
    .catch((error) => process.stdout.write(JSON.stringify({ status: "error", error: error.message })));
}

module.exports = { exactSearchUrl, inferGridDate, parseFlightCard, parseGridCandidate, parseMoney, parseStops, parseDuration };
