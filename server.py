import argparse
import json
import logging
from logging.handlers import RotatingFileHandler
import math
import os
import re
import statistics
import subprocess
import tempfile
import threading
import time
from datetime import date, datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EN_PATH = ROOT / "travel_cities_en.json"
FLIGHT_CACHE = ROOT / "assets" / "flights.json"
FLIGHT_HISTORY = ROOT / "assets" / "flight-history.json"
LOG_PATH = ROOT / "logs" / "app.log"
DIAGNOSTIC_DIR = ROOT / "logs" / "flight-diagnostics"
SCRAPER_PATH = ROOT / "scrape_flight_price.js"

ORIGIN_AIRPORT = "YYZ"
FLIGHT_REFRESH_INTERVAL_SECONDS = 60 * 60
PRICE_EXPIRES_AFTER_SECONDS = 7 * 24 * 60 * 60
DISCOVERY_RESULTS_PER_PROFILE = 5
MAX_CANDIDATES_TO_VERIFY = 2
DEFAULT_MAX_STAY_NIGHTS = 60
CHINA_MAX_STAY_NIGHTS = 180
MIN_COMPARABLE_HISTORY = 3
COMPARABLE_STAY_NIGHTS = 7
COMPARABLE_SEASON_MONTHS = 1
SUSPICIOUS_BASELINE_RATIO = 0.55
MAX_REASONABLE_BASELINE_RATIO = 2.0
DISCOUNT_WEIGHT = 1_000
PRICE_WEIGHT = 0.25
STOP_PENALTY = 90
DURATION_PENALTY = 0.08

AIRPORTS = {
    "Bangkok": ["BKK", "DMK"], "Hong Kong": ["HKG"], "London": ["LHR", "LGW", "STN", "LTN", "LCY"],
    "Macau": ["MFM"], "Istanbul": ["IST", "SAW"], "Dubai": ["DXB", "DWC"], "Paris": ["CDG", "ORY", "BVA"],
    "Kuala Lumpur": ["KUL", "SZB"], "Singapore": ["SIN"], "Tokyo": ["HND", "NRT"],
    "New York": ["JFK", "LGA", "EWR"], "Rome": ["FCO", "CIA"], "Barcelona": ["BCN", "GRO"],
    "Amsterdam": ["AMS"], "Seoul": ["ICN", "GMP"], "Madrid": ["MAD"], "Vienna": ["VIE"],
    "Milan": ["MXP", "LIN", "BGY"], "Prague": ["PRG"], "Berlin": ["BER"], "Lisbon": ["LIS"],
    "Florence": ["FLR", "PSA"], "Venice": ["VCE", "TSF"], "Athens": ["ATH"], "Edinburgh": ["EDI"],
    "Copenhagen": ["CPH"], "Beijing": ["PEK", "PKX"], "Shanghai": ["PVG", "SHA"], "Xi'an": ["XIY"],
    "Chengdu": ["CTU", "TFU"], "Hangzhou": ["HGH"], "Guilin/Yangshuo": ["KWL"],
    "Guangzhou": ["CAN"], "Shenzhen": ["SZX"], "Chongqing": ["CKG"], "Suzhou": ["SHA", "PVG", "WUX"],
}

SHORT_HAUL_CITIES = {"New York"}
TRANSATLANTIC_CITIES = {
    "London", "Paris", "Rome", "Barcelona", "Amsterdam", "Madrid", "Vienna", "Milan", "Prague", "Berlin",
    "Lisbon", "Florence", "Venice", "Athens", "Edinburgh", "Copenhagen", "Istanbul",
}
SUSPICIOUS_MINIMUMS = {"short": 150, "transatlantic": 300, "long_haul": 500}
REPRESENTATIVE_SLUGS = ["new-york", "london", "tokyo"]
GOOGLE_DESTINATION_LABELS = {"Suzhou": "Shanghai"}
CHINA_LONG_STAY_CITIES = {
    "Beijing", "Shanghai", "Xi'an", "Chengdu", "Hangzhou", "Guilin/Yangshuo", "Guangzhou", "Shenzhen",
    "Chongqing", "Suzhou", "Hong Kong", "Macau",
}

_lock = threading.Lock()
_stop = threading.Event()


def configure_logging():
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("travel_guide")
    logger.setLevel(logging.INFO)
    if logger.handlers:
        return logger
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    file_handler = RotatingFileHandler(LOG_PATH, maxBytes=2_000_000, backupCount=5, encoding="utf-8")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)
    return logger


logger = configure_logging()


def slugify(value: str) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return re.sub(r"-+", "-", value).strip("-") or "item"


def load_json(path: Path, fallback):
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        logger.warning("JSON read failed path=%s error=%s", path, exc)
        return fallback


def atomic_write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False) as handle:
            temp_name = handle.name
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


def load_cities():
    return load_json(EN_PATH, [])


def utc_timestamp():
    return int(time.time())


def parse_date(value):
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def month_distance(left, right):
    difference = abs(left - right) % 12
    return min(difference, 12 - difference)


def airport_overlap(left, right):
    return bool(set(left or []) & set(right or []))


def comparable_history(entries, candidate):
    candidate_depart = parse_date(candidate.get("depart_date"))
    candidate_nights = candidate.get("nights")
    candidate_stops = candidate.get("stops") or {}
    candidate_airports = candidate.get("destination_airports") or []
    if not candidate_depart or not isinstance(candidate_nights, int):
        return []
    comparable = []
    for entry in entries:
        if entry.get("verification_status") != "verified":
            continue
        if entry.get("origin_airport") != candidate.get("origin_airport"):
            continue
        entry_depart = parse_date(entry.get("depart_date"))
        if not entry_depart or month_distance(entry_depart.month, candidate_depart.month) > COMPARABLE_SEASON_MONTHS:
            continue
        if not isinstance(entry.get("nights"), int) or abs(entry["nights"] - candidate_nights) > COMPARABLE_STAY_NIGHTS:
            continue
        if candidate_airports and entry.get("destination_airports") and not airport_overlap(candidate_airports, entry["destination_airports"]):
            continue
        entry_stops = entry.get("stops") or {}
        if candidate_stops and entry_stops:
            candidate_total = sum(value for value in candidate_stops.values() if isinstance(value, int))
            entry_total = sum(value for value in entry_stops.values() if isinstance(value, int))
            if abs(candidate_total - entry_total) > 1:
                continue
        price = entry.get("price_cad")
        if isinstance(price, (int, float)):
            comparable.append(entry)
    return comparable


def deal_metadata(candidate, history_entries):
    comparable = comparable_history(history_entries, candidate)
    prices = [entry["price_cad"] for entry in comparable]
    baseline = round(statistics.median(prices)) if prices else None
    price = candidate.get("price_cad")
    discount = round((baseline - price) / baseline * 100) if baseline and isinstance(price, (int, float)) else None
    label = None
    if len(prices) >= MIN_COMPARABLE_HISTORY and discount is not None:
        if discount >= 25:
            label = "exceptional_deal"
        elif discount >= 15:
            label = "good_deal"
        elif discount >= -15:
            label = "fair_price"
        else:
            label = "above_normal"
    elif candidate.get("google_price_insight") == "low":
        label = "good_deal"
    return {
        "deal_label": label,
        "history_median_cad": baseline,
        "history_count": len(prices),
        "discount_percent": discount if label else None,
        "is_deal": label in {"exceptional_deal", "good_deal"},
    }


def stay_limit_for_city(city):
    return CHINA_MAX_STAY_NIGHTS if city in CHINA_LONG_STAY_CITIES else DEFAULT_MAX_STAY_NIGHTS


def discovery_seeds(slug, today=None, max_stay_nights=DEFAULT_MAX_STAY_NIGHTS):
    today = today or date.today()
    city_hash = sum((index + 1) * ord(char) for index, char in enumerate(slug))
    offsets = [45 + city_hash % 45, 150 + city_hash % 90]
    stays = [21 + city_hash % 7, 48 + city_hash % 10]
    if max_stay_nights > DEFAULT_MAX_STAY_NIGHTS:
        offsets.extend([25 + city_hash % 20, 100 + city_hash % 80])
        stays.extend([105 + city_hash % 30, 151 + city_hash % 30])
    seeds = []
    for offset, stay in zip(offsets, stays):
        depart = today + timedelta(days=offset)
        bounded_stay = min(stay, max_stay_nights)
        seeds.append({"depart_date": depart.isoformat(), "return_date": (depart + timedelta(days=bounded_stay)).isoformat()})
    return seeds


def scraper_request(payload, timeout=90):
    try:
        completed = subprocess.run(
            ["node", str(SCRAPER_PATH), json.dumps(payload, ensure_ascii=False, separators=(",", ":"))],
            cwd=ROOT, capture_output=True, text=True, timeout=timeout, check=False,
        )
        result = json.loads(completed.stdout.strip() or "{}")
        if completed.returncode != 0:
            result.setdefault("status", "error")
            result.setdefault("rejection_reason", f"scraper_exit_{completed.returncode}")
        if completed.stderr.strip():
            logger.warning("Scraper stderr city=%s action=%s stderr=%s", payload.get("city"), payload.get("action"), completed.stderr.strip())
        return result
    except subprocess.TimeoutExpired:
        return {"status": "error", "rejection_reason": "scraper_timeout"}
    except Exception as exc:
        logger.exception("Scraper invocation failed city=%s action=%s", payload.get("city"), payload.get("action"))
        return {"status": "error", "rejection_reason": f"scraper_exception:{exc}"}


def base_request(city, slug):
    airports = AIRPORTS.get(city, [])
    return {
        "city": city, "search_city": GOOGLE_DESTINATION_LABELS.get(city, city), "slug": slug, "origin_airport": ORIGIN_AIRPORT,
        "destination_airport": airports[0] if airports else None,
        "allowed_destination_airports": airports,
        "diagnostic_dir": str(DIAGNOSTIC_DIR),
    }


def discover_candidates(city, slug):
    candidates = []
    max_stay_nights = stay_limit_for_city(city)
    for profile, seed in enumerate(discovery_seeds(slug, max_stay_nights=max_stay_nights), start=1):
        request = {**base_request(city, slug), **seed, "action": "discover", "limit": DISCOVERY_RESULTS_PER_PROFILE,
                   "max_stay_nights": max_stay_nights}
        result = scraper_request(request)
        if result.get("status") != "ok":
            logger.warning("Flight discovery failed city=%s profile=%s reason=%s", city, profile, result.get("rejection_reason"))
            continue
        logger.info("Flight discovery city=%s profile=%s candidates=%s", city, profile, len(result.get("candidates", [])))
        candidates.extend(result.get("candidates", []))
    unique = {}
    for candidate in candidates:
        key = (candidate.get("depart_date"), candidate.get("return_date"))
        if all(key) and (key not in unique or candidate.get("estimated_price_cad", math.inf) < unique[key].get("estimated_price_cad", math.inf)):
            unique[key] = candidate
    return sorted(unique.values(), key=lambda item: (item.get("estimated_price_cad", math.inf), item.get("nights", math.inf)))


def verify_candidates(city, slug, candidates):
    verified = []
    rejected = []
    for candidate in candidates[:MAX_CANDIDATES_TO_VERIFY]:
        request = {**base_request(city, slug), **candidate, "action": "verify"}
        result = scraper_request(request)
        if result.get("verification_status") == "verified":
            result["discovered_at"] = utc_timestamp()
            result["verified_at"] = utc_timestamp()
            result["verification_attempts"] = 1
            verified.append(result)
            logger.info("Flight verified city=%s dates=%s/%s price_cad=%s airports=%s", city, result.get("depart_date"), result.get("return_date"), result.get("price_cad"), result.get("destination_airports"))
        else:
            rejected.append({**candidate, "verification_status": "rejected", "rejection_reason": result.get("rejection_reason", "verification_failed")})
            logger.warning("Flight candidate rejected city=%s dates=%s/%s reason=%s", city, candidate.get("depart_date"), candidate.get("return_date"), result.get("rejection_reason"))
    return verified, rejected


def route_band(city):
    if city in SHORT_HAUL_CITIES:
        return "short"
    if city in TRANSATLANTIC_CITIES:
        return "transatlantic"
    return "long_haul"


def is_suspicious(city, candidate, history_entries):
    price = candidate.get("price_cad")
    if not isinstance(price, (int, float)):
        return True
    if price < SUSPICIOUS_MINIMUMS[route_band(city)]:
        return True
    comparable = comparable_history(history_entries, candidate)
    if comparable:
        baseline = statistics.median(entry["price_cad"] for entry in comparable)
        return price < baseline * SUSPICIOUS_BASELINE_RATIO
    return False


def is_implausibly_expensive(candidate, history_entries):
    price = candidate.get("price_cad")
    if not isinstance(price, (int, float)):
        return False
    comparable = comparable_history(history_entries, candidate)
    if len(comparable) < MIN_COMPARABLE_HISTORY:
        return False
    baseline = statistics.median(entry["price_cad"] for entry in comparable)
    return price > baseline * MAX_REASONABLE_BASELINE_RATIO


def recheck_suspicious(city, slug, candidate):
    expected = {"price_cad": candidate["price_cad"], "outbound": candidate.get("outbound"), "return": candidate.get("return")}
    request = {**base_request(city, slug), "action": "recheck", "depart_date": candidate["depart_date"],
               "return_date": candidate["return_date"], "search_url": candidate.get("search_url"), "expected": expected}
    result = scraper_request(request)
    if result.get("verification_status") != "verified":
        logger.warning("Suspicious flight rejected city=%s price_cad=%s reason=%s", city, candidate.get("price_cad"), result.get("rejection_reason"))
        return None
    result["discovered_at"] = candidate.get("discovered_at")
    result["verified_at"] = utc_timestamp()
    result["verification_attempts"] = 2
    logger.info("Suspicious flight recheck passed city=%s price_cad=%s", city, result.get("price_cad"))
    return result


def candidate_score(candidate, history_entries):
    comparable = comparable_history(history_entries, candidate)
    baseline = statistics.median(entry["price_cad"] for entry in comparable) if comparable else None
    discount = (baseline - candidate["price_cad"]) / baseline if baseline else 0
    stops = sum(value for value in (candidate.get("stops") or {}).values() if isinstance(value, int))
    duration = sum(value for value in (candidate.get("journey_duration_minutes") or {}).values() if isinstance(value, int))
    return discount * DISCOUNT_WEIGHT - candidate["price_cad"] * PRICE_WEIGHT - stops * STOP_PENALTY - duration * DURATION_PENALTY


def public_record(candidate, history_entries):
    record = {key: value for key, value in candidate.items() if key not in {"outbound", "return", "raw_text"}}
    record.update(deal_metadata(candidate, history_entries))
    record["status"] = "verified"
    record["last_successfully_verified_at"] = candidate.get("verified_at")
    return record


def history_record(slug, city, candidate, deal):
    return {
        "key": f"{candidate['depart_date']}|{candidate['return_date']}|{candidate['verified_at']}",
        "slug": slug, "city": city, "price_cad": candidate["price_cad"], "currency": "CAD",
        "origin_airport": candidate["origin_airport"], "destination_airports": candidate.get("destination_airports", []),
        "depart_date": candidate["depart_date"], "return_date": candidate["return_date"], "nights": candidate["nights"],
        "airlines": candidate.get("airlines", []), "airline": candidate.get("airline"), "stops": candidate.get("stops"),
        "journey_duration_minutes": candidate.get("journey_duration_minutes"), "journey_duration": candidate.get("journey_duration"),
        "cabin_fare": candidate.get("cabin_fare"), "baggage": candidate.get("baggage"), "url": candidate.get("exact_url"),
        "search_url": candidate.get("search_url"), "discovered_at": candidate.get("discovered_at"),
        "verified_at": candidate.get("verified_at"), "searched_at": candidate.get("verified_at"),
        "google_price_insight": candidate.get("google_price_insight"), "verification_status": "verified",
        "verification_attempts": candidate.get("verification_attempts", 1), "deal_label": deal.get("deal_label"),
        "history_median_cad": deal.get("history_median_cad"), "history_count": deal.get("history_count"),
    }


def retained_record(previous, final_status, attempted_at, reason=None):
    if previous.get("verification_status") == "verified" or previous.get("status") in {"verified", "updating", "temporarily_unavailable", "expired"}:
        record = dict(previous)
        verified_at = record.get("last_successfully_verified_at") or record.get("verified_at")
        expired = isinstance(verified_at, int) and attempted_at - verified_at > PRICE_EXPIRES_AFTER_SECONDS
        record["status"] = "expired" if expired else final_status
        record["refresh_error"] = reason
        record["last_refresh_attempt_at"] = attempted_at
        return record
    return {"status": final_status, "price_cad": None, "currency": "CAD", "last_refresh_attempt_at": attempted_at,
            "refresh_error": reason, "legacy_unverified": previous or None}


def retained_or_suppressed_record(previous, final_status, attempted_at, history_entries, reason=None):
    if not is_implausibly_expensive(previous, history_entries):
        return retained_record(previous, final_status, attempted_at, reason)
    record = dict(previous)
    record.update({
        "status": final_status,
        "verification_status": "rejected",
        "price_cad": None,
        "deal_label": None,
        "discount_percent": None,
        "is_deal": False,
        "suppression_reason": "extreme_high_price_outlier",
        "suppressed_price_cad": previous.get("price_cad"),
        "refresh_error": reason or "extreme_high_price_outlier",
        "last_refresh_attempt_at": attempted_at,
    })
    return record


def write_state(cache, history):
    with _lock:
        atomic_write_json(FLIGHT_HISTORY, history)
        atomic_write_json(FLIGHT_CACHE, cache)


def refresh_flights(selected_slugs=None):
    started_at = utc_timestamp()
    selected = set(selected_slugs or [])
    cities = [item for item in load_cities() if not selected or slugify(item["city"]) in selected]
    previous_cache = load_json(FLIGHT_CACHE, {"prices": {}})
    previous_prices = previous_cache.get("prices", {})
    history = load_json(FLIGHT_HISTORY, {})
    prices = dict(previous_prices)
    cache = {
        "schema_version": 2, "origin": ORIGIN_AIRPORT, "updated_at": started_at,
        "refresh_started_at": started_at, "refresh_completed_at": None, "refresh_status": "updating", "prices": prices,
    }
    for item in cities:
        slug = slugify(item["city"])
        prices[slug] = retained_or_suppressed_record(
            previous_prices.get(slug, {}), "updating", started_at, history.get(slug, []))
        if prices[slug].get("suppression_reason") == "extreme_high_price_outlier":
            logger.warning("Cached extreme high flight price suppressed city=%s price_cad=%s",
                           item["city"], prices[slug].get("suppressed_price_cad"))
    write_state(cache, history)
    logger.info("Flight refresh started cities=%s selected=%s", len(cities), sorted(selected) if selected else "all")

    success_count = 0
    failure_count = 0
    for item in cities:
        if _stop.is_set():
            break
        city = item["city"]
        slug = slugify(city)
        if not AIRPORTS.get(city):
            prices[slug] = retained_or_suppressed_record(
                previous_prices.get(slug, {}), "temporarily_unavailable", utc_timestamp(), history.get(slug, []),
                "missing_airport_mapping")
            logger.warning("No airport mapping city=%s", city)
            failure_count += 1
            continue
        try:
            candidates = discover_candidates(city, slug)
            if not candidates:
                prices[slug] = retained_or_suppressed_record(
                    previous_prices.get(slug, {}), "no_verified_fare", utc_timestamp(), history.get(slug, []),
                    "no_discovery_candidates")
                logger.warning("No discovery candidates city=%s retained_previous=%s", city, bool(prices[slug].get("price_cad")))
                failure_count += 1
                write_state(cache, history)
                continue
            verified, rejected = verify_candidates(city, slug, candidates)
            history_entries = history.setdefault(slug, [])
            accepted = []
            for candidate in verified:
                if is_implausibly_expensive(candidate, history_entries):
                    metadata = deal_metadata(candidate, history_entries)
                    rejected.append({"verification_status": "rejected", "rejection_reason": "extreme_high_price_outlier",
                                     "depart_date": candidate.get("depart_date"), "return_date": candidate.get("return_date"),
                                     "price_cad": candidate.get("price_cad")})
                    logger.warning("Extreme high flight price rejected city=%s price_cad=%s history_median_cad=%s history_count=%s",
                                   city, candidate.get("price_cad"), metadata.get("history_median_cad"),
                                   metadata.get("history_count"))
                    continue
                if is_suspicious(city, candidate, history_entries):
                    checked = recheck_suspicious(city, slug, candidate)
                    if checked:
                        accepted.append(checked)
                    else:
                        rejected.append({"verification_status": "rejected", "rejection_reason": "suspicious_recheck_failed",
                                         "depart_date": candidate.get("depart_date"), "return_date": candidate.get("return_date"),
                                         "price_cad": candidate.get("price_cad")})
                else:
                    accepted.append(candidate)
            if not accepted:
                reason = rejected[-1]["rejection_reason"] if rejected else "no_verified_candidate"
                prices[slug] = retained_or_suppressed_record(
                    previous_prices.get(slug, {}), "no_verified_fare", utc_timestamp(), history_entries, reason)
                logger.warning("No verified fare city=%s rejected=%s retained_previous=%s", city, len(rejected), bool(prices[slug].get("price_cad")))
                failure_count += 1
            else:
                best = max(accepted, key=lambda candidate: candidate_score(candidate, history_entries))
                deal = deal_metadata(best, history_entries)
                prices[slug] = public_record(best, history_entries)
                observation = history_record(slug, city, best, deal)
                if not any(entry.get("key") == observation["key"] for entry in history_entries):
                    history_entries.append(observation)
                success_count += 1
                logger.info("Flight published city=%s price_cad=%s dates=%s/%s nights=%s stops=%s label=%s candidates=%s",
                            city, best["price_cad"], best["depart_date"], best["return_date"], best["nights"], best.get("stops"),
                            prices[slug].get("deal_label"), len(accepted))
        except Exception as exc:
            failure_count += 1
            prices[slug] = retained_or_suppressed_record(
                previous_prices.get(slug, {}), "temporarily_unavailable", utc_timestamp(), history.get(slug, []), str(exc))
            logger.exception("Unexpected flight refresh exception city=%s retained_previous=%s", city, bool(prices[slug].get("price_cad")))
        cache["updated_at"] = utc_timestamp()
        write_state(cache, history)

    cache["updated_at"] = utc_timestamp()
    cache["refresh_completed_at"] = cache["updated_at"]
    cache["refresh_status"] = "complete" if failure_count == 0 else "partial"
    write_state(cache, history)
    logger.info("Flight refresh finished successes=%s failures=%s duration_seconds=%s", success_count, failure_count, cache["updated_at"] - started_at)
    return {"successes": success_count, "failures": failure_count, "cities": len(cities), "status": cache["refresh_status"]}


def scheduler_loop():
    while not _stop.is_set():
        cycle_started_at = time.monotonic()
        refresh_flights()
        elapsed = time.monotonic() - cycle_started_at
        _stop.wait(max(0, FLIGHT_REFRESH_INTERVAL_SECONDS - elapsed))


class Handler(SimpleHTTPRequestHandler):
    def _send_json(self, payload, code=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/flights":
            if FLIGHT_CACHE.exists():
                with _lock:
                    return self._send_json(load_json(FLIGHT_CACHE, {"prices": {}}))
            return self._send_json({"prices": {}, "refresh_status": "unavailable"}, code=503)
        return super().do_GET()


def run(port=8000):
    logger.info("Server starting port=%s root=%s", port, ROOT)
    background = threading.Thread(target=scheduler_loop, daemon=True)
    background.start()
    server = ThreadingHTTPServer(("", port), Handler)
    print(f"Serving on http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _stop.set()
        server.server_close()
        logger.info("Server stopped port=%s", port)


def main():
    parser = argparse.ArgumentParser(description="Travel guide server and verified Google Flights refresh")
    parser.add_argument("--refresh", action="store_true", help="run one flight refresh and exit")
    parser.add_argument("--validate-representative", action="store_true", help="refresh New York, London, and Tokyo")
    parser.add_argument("--cities", help="comma-separated city slugs for a focused refresh")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if args.validate_representative:
        result = refresh_flights(REPRESENTATIVE_SLUGS)
        print(json.dumps(result))
        raise SystemExit(0 if result["failures"] == 0 else 1)
    if args.refresh:
        selected = [value.strip() for value in args.cities.split(",")] if args.cities else None
        result = refresh_flights(selected)
        print(json.dumps(result))
        raise SystemExit(0 if result["failures"] == 0 else 1)
    run(args.port)


if __name__ == "__main__":
    main()
