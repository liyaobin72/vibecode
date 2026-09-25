import tempfile
import unittest
from unittest.mock import MagicMock, patch
from datetime import date
from pathlib import Path

import server


class FlightDealTests(unittest.TestCase):
    def candidate(self, price=800):
        return {
            "price_cad": price, "origin_airport": "YYZ", "destination_airports": ["LHR"],
            "depart_date": "2027-05-10", "return_date": "2027-06-01", "nights": 22,
            "stops": {"outbound": 0, "return": 0}, "google_price_insight": None,
        }

    def observation(self, price, key):
        return {
            "key": key, "price_cad": price, "origin_airport": "YYZ", "destination_airports": ["LHR"],
            "depart_date": "2026-05-12", "return_date": "2026-06-03", "nights": 22,
            "stops": {"outbound": 0, "return": 0}, "verification_status": "verified",
        }

    def test_comparison_uses_verified_comparable_history_and_median(self):
        entries = [self.observation(1000, "a"), self.observation(1200, "b"), self.observation(1100, "c")]
        entries += [{**self.observation(100, "unverified"), "verification_status": "rejected"}]
        metadata = server.deal_metadata(self.candidate(800), entries)
        self.assertEqual(metadata["history_median_cad"], 1100)
        self.assertEqual(metadata["history_count"], 3)
        self.assertEqual(metadata["deal_label"], "exceptional_deal")

    def test_current_observation_is_excluded_when_decorating(self):
        entries = [self.observation(1000, "a"), self.observation(1200, "b"), self.observation(1100, "c")]
        metadata = server.deal_metadata(self.candidate(200), entries)
        self.assertEqual(metadata["history_count"], 3)
        self.assertEqual(metadata["history_median_cad"], 1100)

    def test_unexpectedly_low_candidate_is_suspicious(self):
        entries = [self.observation(1000, "a"), self.observation(1050, "b"), self.observation(1100, "c")]
        self.assertTrue(server.is_suspicious("London", self.candidate(400), entries))
        self.assertFalse(server.is_suspicious("London", self.candidate(800), entries))

    def test_suspicious_candidate_requires_fresh_second_verification(self):
        candidate = {**self.candidate(400), "outbound": {"origin_airport": "YYZ"}, "return": {"destination_airport": "YYZ"},
                     "search_url": "https://example.test/search", "discovered_at": 10}
        verified_again = {**candidate, "verification_status": "verified", "status": "verified"}
        with patch.object(server, "scraper_request", return_value=verified_again) as request:
            result = server.recheck_suspicious("London", "london", candidate)
        self.assertEqual(result["verification_attempts"], 2)
        payload = request.call_args.args[0]
        self.assertEqual(payload["action"], "recheck")
        self.assertEqual(payload["expected"]["price_cad"], 400)

    def test_legacy_price_is_not_published_as_verified(self):
        retained = server.retained_record({"price_cad": 400, "url": "legacy"}, "updating", 1000)
        self.assertIsNone(retained["price_cad"])
        self.assertEqual(retained["legacy_unverified"]["price_cad"], 400)

    def test_verified_price_keeps_its_original_dates_on_failure(self):
        previous = {"price_cad": 400, "verification_status": "verified", "status": "verified",
                    "depart_date": "2027-01-02", "return_date": "2027-01-20", "verified_at": 900}
        retained = server.retained_record(previous, "temporarily_unavailable", 1000, "blocked")
        self.assertEqual(retained["price_cad"], 400)
        self.assertEqual(retained["depart_date"], "2027-01-02")
        self.assertEqual(retained["return_date"], "2027-01-20")

    def test_discovery_profiles_vary_dates_and_stays_by_city(self):
        new_york = server.discovery_seeds("new-york", date(2026, 9, 24))
        tokyo = server.discovery_seeds("tokyo", date(2026, 9, 24))
        self.assertEqual(len(new_york), 2)
        self.assertNotEqual(new_york, tokyo)
        stays = [(date.fromisoformat(seed["return_date"]) - date.fromisoformat(seed["depart_date"])).days for seed in new_york]
        self.assertTrue(all(14 <= nights <= 60 for nights in stays))
        self.assertGreater(max(stays) - min(stays), 20)

    def test_atomic_json_write(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "cache.json"
            server.atomic_write_json(target, {"ok": True})
            self.assertEqual(server.load_json(target, {}), {"ok": True})
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_scheduler_starts_refreshes_hourly_without_overlap(self):
        stop_event = MagicMock()
        stop_event.is_set.side_effect = [False, True]
        with patch.object(server, "_stop", stop_event), patch.object(server, "refresh_flights") as refresh, \
                patch.object(server.time, "monotonic", side_effect=[100, 130]):
            server.scheduler_loop()
        refresh.assert_called_once_with()
        stop_event.wait.assert_called_once_with((60 * 60) - 30)

    def test_scheduler_does_not_overlap_a_refresh_longer_than_one_hour(self):
        stop_event = MagicMock()
        stop_event.is_set.side_effect = [False, True]
        with patch.object(server, "_stop", stop_event), patch.object(server, "refresh_flights"), \
                patch.object(server.time, "monotonic", side_effect=[100, 3800]):
            server.scheduler_loop()
        stop_event.wait.assert_called_once_with(0)


if __name__ == "__main__":
    unittest.main()
