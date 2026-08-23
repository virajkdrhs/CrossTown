"""End-to-end API tests against a live server.

    python -m unittest tests.test_api

Skips itself with a clear message if the API is not running, so the suite is
safe to run unattended.
"""

from __future__ import annotations

import json
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

BASE = "http://127.0.0.1:8000"


def _request(path, payload=None, method=None):
    url = f"{BASE}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        body = error.read()
        try:
            return error.code, json.loads(body)
        except ValueError:
            return error.code, {"raw": body.decode(errors="replace")}


def server_up() -> bool:
    try:
        status, _ = _request("/api/v1/health")
        return status == 200
    except Exception:  # noqa: BLE001
        return False


@unittest.skipUnless(server_up(), "API not running on 127.0.0.1:8000")
class TestAPI(unittest.TestCase):
    def test_root_and_health(self):
        status, body = _request("/")
        self.assertEqual(status, 200)
        status, body = _request("/api/v1/health")
        self.assertEqual(body["status"], "ok")
        self.assertIn(body["data_source"], ("geojson-files", "postgis"))

    def test_grid_scored(self):
        status, body = _request("/api/v1/grid")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["features"]), 130)
        props = body["features"][0]["properties"]
        for key in ("access_score_100", "food_100", "health_100", "band"):
            self.assertIn(key, props)
        for feature in body["features"]:
            score = feature["properties"]["access_score_100"]
            self.assertGreaterEqual(score, 0)
            self.assertLessEqual(score, 100)

    def test_demographics_have_real_variation(self):
        status, body = _request("/api/v1/demographics")
        self.assertEqual(status, 200)
        values = {round(f["properties"]["pct_carfree"], 2) for f in body["features"]}
        self.assertGreater(len(values), 5, "census layer looks like placeholder data again")

    def test_stats_equity(self):
        status, body = _request("/api/v1/stats")
        self.assertEqual(status, 200)
        self.assertTrue(body["equity"]["available"])
        self.assertGreater(body["equity"]["carfree_households"], 0)

    def test_destinations_filter(self):
        status, body = _request("/api/v1/destinations?category=Civic")
        self.assertEqual(status, 200)
        self.assertTrue(body["features"])
        self.assertTrue(
            all(f["properties"]["category"] == "Civic" for f in body["features"])
        )

    def test_node_lookup_and_404(self):
        status, body = _request("/api/v1/node/36")
        self.assertEqual(status, 200)
        self.assertEqual(body["id"], 36)
        status, _ = _request("/api/v1/node/999999")
        self.assertEqual(status, 404)

    def test_transit_health(self):
        status, body = _request("/api/v2/transit/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["available"])
        self.assertGreater(body["stops"], 1000)

    def test_transit_stops_geojson(self):
        status, body = _request("/api/v2/transit/stops")
        self.assertEqual(status, 200)
        self.assertGreater(len(body["features"]), 1000)

    def test_microtransit_zones(self):
        status, body = _request("/api/v2/microtransit/zones")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["features"]), 6)
        props = body["features"][0]["properties"]
        self.assertIn("runs_today", props)
        self.assertEqual(props["fare"], "Free")
        self.assertIn("boundaries", body["metadata"])

    def test_commute_viable(self):
        status, body = _request(
            "/api/v2/commute",
            {
                "origin": {"lat": 37.55, "lon": -77.33, "name": "Highland Springs"},
                "destination": {"lat": 37.5407, "lon": -77.436, "name": "Downtown"},
                "shift_start": "09:00",
                "shift_end": "17:00",
            },
        )
        self.assertEqual(status, 200)
        self.assertIn(body["verdict"], ("viable", "marginal"))
        self.assertIsNotNone(body["outbound"])
        self.assertEqual(body["cost"]["transit_fare_usd"], 0.0)

    def test_commute_microtransit_verdict(self):
        status, body = _request(
            "/api/v2/commute",
            {
                "origin": {"lat": 37.44, "lon": -77.32, "name": "Varina"},
                "destination": {"lat": 37.5052, "lon": -77.3197, "name": "Airport"},
                "shift_start": "08:00",
                "shift_end": "16:00",
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["verdict"], "microtransit")
        self.assertTrue(body["has_microtransit_option"])
        self.assertFalse(body["carpool_recommended"])

    def test_commute_rejects_short_address(self):
        status, _ = _request(
            "/api/v2/commute",
            {"origin": {"address": "x"}, "destination": {"address": "y"}},
        )
        self.assertEqual(status, 422)

    def test_commute_rejects_bad_time(self):
        status, _ = _request(
            "/api/v2/commute",
            {
                "origin": {"lat": 37.55, "lon": -77.33},
                "destination": {"lat": 37.54, "lon": -77.43},
                "shift_start": "99:99",
            },
        )
        self.assertEqual(status, 422)

    def test_commute_rejects_out_of_range_day(self):
        status, body = _request(
            "/api/v2/commute",
            {
                "origin": {"lat": 37.55, "lon": -77.33},
                "destination": {"lat": 37.54, "lon": -77.43},
                "day": "2020-01-01",
            },
        )
        self.assertEqual(status, 422)

    def test_roster_gaps(self):
        status, roster = _request("/api/v2/demo/roster")
        self.assertEqual(status, 200)
        status, body = _request(
            "/api/v2/roster/gaps",
            {
                "worksite": {"lat": 37.65, "lon": -77.61, "name": "Short Pump"},
                "shift_start": "09:00",
                "shift_end": "17:00",
                "employees": roster["employees"],
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["summary"]["employees_analysed"], 60)
        total = sum(body["summary"]["verdicts"].values())
        self.assertEqual(total, 60, "every employee must land in exactly one verdict bucket")
        for employee in body["employees"]:
            self.assertIn("has_microtransit_option", employee)

    def test_roster_rejects_empty_employee_list(self):
        status, _ = _request(
            "/api/v2/roster/gaps",
            {"worksite": {"lat": 37.65, "lon": -77.61}, "employees": []},
        )
        self.assertEqual(status, 422)

    def test_carpool_plan(self):
        status, roster = _request("/api/v2/demo/roster")
        status, body = _request(
            "/api/v2/carpool/plan",
            {
                "worksite": {"lat": 37.65, "lon": -77.61, "name": "Short Pump"},
                "shift_start": "09:00",
                "shift_end": "17:00",
                "employees": roster["employees"],
                "seats_per_driver": 3,
                "max_detour_minutes": 20,
            },
        )
        self.assertEqual(status, 200)
        summary = body["summary"]
        self.assertGreater(summary["riders_matched"], 0)
        self.assertEqual(
            summary["riders_matched"] + summary["riders_unmatched"],
            summary["riders_needing_ride"],
            "every rider must be either matched or explained",
        )
        for pool in body["pools"]:
            self.assertGreaterEqual(pool["detour_minutes"], 0)
            self.assertLessEqual(pool["seats_used"], 3)
            self.assertGreaterEqual(len(pool["route"]), 2)

    def test_carpool_rejects_bad_seat_count(self):
        status, roster = _request("/api/v2/demo/roster")
        status, _ = _request(
            "/api/v2/carpool/plan",
            {
                "worksite": {"lat": 37.65, "lon": -77.61},
                "employees": roster["employees"][:3],
                "seats_per_driver": 99,
            },
        )
        self.assertEqual(status, 422)

    def test_openapi_docs_available(self):
        status, body = _request("/openapi.json")
        self.assertEqual(status, 200)
        self.assertIn("/api/v2/carpool/plan", body["paths"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
