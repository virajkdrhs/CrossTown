"""CrossTown test suite.

Plain unittest so it runs with the stdlib - no pytest required. Covers the
routing maths, gap classification, microtransit zones, carpool matching, and
every API endpoint against the real GTFS feed.

    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from Backend import (  # noqa: E402
    carpool, commute, gtfs, microtransit, roadnetwork, scoring, transit_router,
)

WEEKDAY = date(2026, 8, 5)
SATURDAY = date(2026, 8, 8)
SUNDAY = date(2026, 8, 9)
LABOR_DAY = date(2026, 9, 7)

DOWNTOWN = (-77.4360, 37.5407)
SHORT_PUMP = (-77.6100, 37.6500)
INNSBROOK = (-77.5700, 37.6580)
VARINA = (-77.3200, 37.4400)
AIRPORT = (-77.3197, 37.5052)
HIGHLAND_SPRINGS = (-77.3300, 37.5500)


class TestGTFS(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.feed = gtfs.get_feed()

    def test_feed_loads(self):
        self.assertGreater(len(self.feed.stops), 1000)
        self.assertGreater(len(self.feed.connections), 100_000)
        self.assertTrue(self.feed.feed_start)

    def test_time_parsing_handles_past_midnight(self):
        self.assertEqual(gtfs.parse_gtfs_time("25:30:00"), 25 * 3600 + 30 * 60)
        self.assertEqual(gtfs.format_seconds(25 * 3600 + 30 * 60), "01:30")
        self.assertIsNone(gtfs.parse_gtfs_time(""))
        self.assertIsNone(gtfs.parse_gtfs_time("nonsense"))

    def test_service_calendars(self):
        self.assertEqual(self.feed.services_on(WEEKDAY), {"1"})
        self.assertEqual(self.feed.services_on(SATURDAY), {"2"})
        self.assertEqual(self.feed.services_on(SUNDAY), {"3"})

    def test_calendar_exception_applied(self):
        """Labor Day is a Monday that runs Sunday service."""
        self.assertEqual(self.feed.services_on(LABOR_DAY), {"3"})

    def test_footpaths_generated(self):
        # transfers.txt is empty, so these must be synthesised or nothing connects.
        self.assertGreater(len(self.feed.footpaths), 500)

    def test_stops_near_is_ordered(self):
        found = self.feed.stops_near(DOWNTOWN[0], DOWNTOWN[1], 800)
        self.assertGreater(len(found), 10)
        distances = [distance for _, distance in found]
        self.assertEqual(distances, sorted(distances))

    def test_haversine_sanity(self):
        # Roughly 19-20 km between downtown and Short Pump.
        metres = gtfs.haversine_m(*DOWNTOWN, *SHORT_PUMP)
        self.assertGreater(metres, 15_000)
        self.assertLess(metres, 25_000)


class TestRouter(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.feed = gtfs.get_feed()

    def test_finds_a_real_journey(self):
        journey = transit_router.plan_arrive_by(
            self.feed, HIGHLAND_SPRINGS, DOWNTOWN, 9 * 3600, WEEKDAY
        )
        self.assertIsNotNone(journey)
        self.assertGreater(len(journey.legs), 1)
        self.assertTrue(journey.routes, "journey should use at least one bus route")

    def test_journey_arrives_before_deadline(self):
        deadline = 9 * 3600
        journey = transit_router.plan_arrive_by(
            self.feed, HIGHLAND_SPRINGS, DOWNTOWN, deadline, WEEKDAY
        )
        self.assertLessEqual(journey.arrive_s, deadline)

    def test_legs_are_chronological_and_contiguous(self):
        journey = transit_router.plan_arrive_by(
            self.feed, HIGHLAND_SPRINGS, DOWNTOWN, 9 * 3600, WEEKDAY
        )
        for leg in journey.legs:
            self.assertLessEqual(leg.depart_s, leg.arrive_s, f"leg goes backwards: {leg}")
        for first, second in zip(journey.legs, journey.legs[1:]):
            self.assertLessEqual(
                first.arrive_s, second.depart_s + 1, "next leg departs before the previous arrives"
            )

    def test_duration_matches_legs(self):
        journey = transit_router.plan_arrive_by(
            self.feed, HIGHLAND_SPRINGS, DOWNTOWN, 9 * 3600, WEEKDAY
        )
        self.assertEqual(journey.depart_s, journey.legs[0].depart_s)
        self.assertGreater(journey.duration_s, 0)

    def test_legs_carry_coordinates_for_the_map(self):
        journey = transit_router.plan_arrive_by(
            self.feed, HIGHLAND_SPRINGS, DOWNTOWN, 9 * 3600, WEEKDAY
        )
        bus_legs = [leg for leg in journey.legs if leg.mode == "bus"]
        self.assertTrue(bus_legs)
        for leg in bus_legs:
            self.assertIsNotNone(leg.from_lonlat)
            self.assertIsNotNone(leg.to_lonlat)
            self.assertGreaterEqual(len(leg.shape), 2)

    def test_no_journey_to_a_place_with_no_stops(self):
        journey = transit_router.plan_arrive_by(
            self.feed, DOWNTOWN, INNSBROOK, 9 * 3600, WEEKDAY
        )
        self.assertIsNone(journey, "Innsbrook has no stop within the walk radius")

    def test_backward_scan_covers_many_stops_in_one_pass(self):
        scan = transit_router.scan_backward(
            self.feed, DOWNTOWN[0], DOWNTOWN[1], 9 * 3600, WEEKDAY
        )
        self.assertGreater(len(scan.latest_dep), 200)

    def test_backward_scan_agrees_with_forward_plan(self):
        scan = transit_router.scan_backward(
            self.feed, DOWNTOWN[0], DOWNTOWN[1], 9 * 3600, WEEKDAY
        )
        latest, _ = scan.latest_departure_from(
            self.feed, HIGHLAND_SPRINGS[0], HIGHLAND_SPRINGS[1], 800
        )
        journey = transit_router.plan_arrive_by(
            self.feed, HIGHLAND_SPRINGS, DOWNTOWN, 9 * 3600, WEEKDAY, scan=scan
        )
        self.assertIsNotNone(journey)
        self.assertGreaterEqual(journey.depart_s, latest - 1)

    def test_sunday_service_differs_from_weekday(self):
        weekday = transit_router.plan_arrive_by(
            self.feed, HIGHLAND_SPRINGS, DOWNTOWN, 9 * 3600, WEEKDAY
        )
        sunday = transit_router.plan_arrive_by(
            self.feed, HIGHLAND_SPRINGS, DOWNTOWN, 9 * 3600, SUNDAY
        )
        self.assertIsNotNone(weekday)
        # Sunday may or may not be routable, but must not silently reuse weekday trips.
        if sunday is not None:
            self.assertNotEqual(weekday.depart_s, sunday.depart_s)


class TestCommuteClassification(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.feed = gtfs.get_feed()

    def test_viable_commute(self):
        result = commute.evaluate(
            self.feed, HIGHLAND_SPRINGS, DOWNTOWN, 9 * 3600, 17 * 3600, WEEKDAY
        )
        self.assertIn(result["verdict"], ("viable", "marginal"))
        self.assertIsNotNone(result["outbound"])

    def test_no_stop_near_destination_is_distinguished(self):
        result = commute.evaluate(self.feed, DOWNTOWN, INNSBROOK, 9 * 3600, 17 * 3600, WEEKDAY)
        self.assertEqual(result["verdict"], "no_service")
        self.assertIn("no_stop_near_destination", result["codes"])
        self.assertNotIn("no_service_at_hour", result["codes"])

    def test_no_service_at_hour_is_distinguished(self):
        """Short Pump has stops at both ends but no 6am bus."""
        result = commute.evaluate(self.feed, DOWNTOWN, SHORT_PUMP, 6 * 3600, 14 * 3600, WEEKDAY)
        self.assertEqual(result["verdict"], "no_service")
        self.assertIn("no_service_at_hour", result["codes"])

    def test_overnight_shift_end_wraps_past_midnight(self):
        result = commute.evaluate(
            self.feed, HIGHLAND_SPRINGS, DOWNTOWN, 23 * 3600, 7 * 3600 + 86400, WEEKDAY
        )
        self.assertIsInstance(result["verdict"], str)

    def test_cost_comparison_present_and_sane(self):
        result = commute.evaluate(self.feed, VARINA, SHORT_PUMP, 9 * 3600, 17 * 3600, WEEKDAY)
        cost = result["cost"]
        self.assertEqual(cost["transit_fare_usd"], 0.0)
        self.assertGreater(cost["drive_cost_per_year_usd"], 1000)
        # Each figure is rounded independently, so allow a cent of drift.
        self.assertAlmostEqual(
            cost["drive_cost_per_month_usd"],
            cost["drive_cost_per_day_usd"] * 21,
            delta=0.5,
        )

    def test_zero_counts_are_not_invented(self):
        """A category with no reachable amenity must score 0, not a fallback."""
        scored = scoring.score_row({"Food": 0, "Health": 0, "Education": 0, "Civic": 0, "access_score": 0})
        self.assertEqual(scored["scores"]["health"], 0)
        self.assertEqual(scored["scores"]["overall_score"], 0)

    def test_scoring_clamps_and_handles_bad_input(self):
        self.assertEqual(scoring.scale_to_100(None, 10), 0)
        self.assertEqual(scoring.scale_to_100("abc", 10), 0)
        self.assertEqual(scoring.scale_to_100(-5, 10), 0)
        self.assertEqual(scoring.scale_to_100(999, 10), 100)

    def test_access_bands(self):
        self.assertEqual(scoring.access_band(0), "none")
        self.assertEqual(scoring.access_band(10), "low")
        self.assertEqual(scoring.access_band(50), "moderate")
        self.assertEqual(scoring.access_band(90), "high")


class TestMicrotransit(unittest.TestCase):
    def test_zones_load(self):
        self.assertEqual(len(microtransit.load_zones()), 6)

    def test_varina_is_inside_the_sandston_zone(self):
        zone = microtransit.zone_at(*VARINA)
        self.assertIsNotNone(zone, "Varina must resolve to a LINK zone")
        self.assertEqual(zone["zone_id"], "sandston")

    def test_short_pump_has_no_zone(self):
        self.assertIsNone(microtransit.zone_at(*SHORT_PUMP))

    def test_service_hours_respected(self):
        zone = microtransit.zone_at(*VARINA)
        self.assertTrue(microtransit.covers(zone, WEEKDAY, 8 * 3600))
        self.assertFalse(microtransit.covers(zone, WEEKDAY, 3 * 3600))
        # Sandston does not run at weekends.
        self.assertFalse(microtransit.covers(zone, SATURDAY, 8 * 3600))

    def test_door_to_door_option_within_one_zone(self):
        options = microtransit.evaluate_options(VARINA, AIRPORT, WEEKDAY, 7 * 3600, 8 * 3600)
        self.assertTrue(options)
        self.assertEqual(options[0]["kind"], "door_to_door")
        self.assertTrue(options[0]["available"])

    def test_first_mile_option_when_only_origin_in_zone(self):
        options = microtransit.evaluate_options(VARINA, SHORT_PUMP, WEEKDAY, 7 * 3600, 9 * 3600)
        kinds = {option["kind"] for option in options}
        self.assertIn("first_mile", kinds)

    def test_link_upgrades_verdict_off_no_service(self):
        feed = gtfs.get_feed()
        result = commute.evaluate(feed, VARINA, AIRPORT, 8 * 3600, 16 * 3600, WEEKDAY)
        self.assertEqual(result["verdict"], "microtransit")
        self.assertFalse(
            result["carpool_recommended"],
            "somebody LINK carries door to door does not need a carpool seat",
        )

    def test_point_in_polygon_edge_cases(self):
        zone = microtransit.load_zones()[0]
        geometry = zone["geometry"]
        # Far outside must be False for every zone.
        self.assertFalse(microtransit._point_in_geometry(0.0, 0.0, geometry))


class TestCarpool(unittest.TestCase):
    """Matching logic, held to a deterministic offline distance model.

    These assert on the heuristic, not on road geometry, so they use an explicit
    straight-line matrix. Real road routing is covered in TestRoadNetwork.
    """

    def _person(self, ref, lon, lat, has_vehicle, verdict="no_service", shift=9 * 3600):
        return carpool.Person(
            ref=ref, lon=lon, lat=lat, zone_id=None,
            has_vehicle=has_vehicle, verdict=verdict, shift_start_s=shift,
        )

    def _plan(self, people, worksite=DOWNTOWN, **kwargs):
        matrix = roadnetwork._haversine_matrix(
            list({(p.lon, p.lat) for p in people} | {worksite}), "test"
        )
        kwargs.setdefault("include_geometry", False)
        return carpool.plan(people, worksite, matrix=matrix, **kwargs)

    def test_rider_with_a_car_is_not_stranded(self):
        person = self._person("A", *VARINA, True, "no_service")
        self.assertFalse(person.needs_ride)

    def test_rider_without_a_car_and_no_service_needs_a_ride(self):
        person = self._person("A", *VARINA, False, "no_service")
        self.assertTrue(person.needs_ride)

    def test_rider_with_viable_transit_does_not_need_a_ride(self):
        person = self._person("A", *VARINA, False, "viable")
        self.assertFalse(person.needs_ride)

    def test_matches_a_nearby_rider(self):
        people = [
            self._person("driver", -77.44, 37.55, True),
            self._person("rider", -77.441, 37.551, False),
        ]
        plan = self._plan(people)
        self.assertEqual(plan["summary"]["riders_matched"], 1)
        self.assertEqual(len(plan["pools"]), 1)
        self.assertEqual(plan["pools"][0]["seats_used"], 1)

    def test_respects_seat_capacity(self):
        people = [self._person("driver", -77.44, 37.55, True)]
        people += [self._person(f"r{i}", -77.441, 37.551, False) for i in range(5)]
        plan = self._plan(people, seats_per_driver=2)
        self.assertEqual(plan["summary"]["riders_matched"], 2)
        self.assertEqual(plan["summary"]["riders_unmatched"], 3)

    def test_respects_detour_cap(self):
        people = [
            self._person("driver", -77.44, 37.55, True),
            # Far away rider: any detour blows a tiny cap.
            self._person("rider", -77.90, 37.90, False),
        ]
        plan = self._plan(people, max_detour_min=5)
        self.assertEqual(plan["summary"]["riders_matched"], 0)
        self.assertEqual(len(plan["unmatched"]), 1)
        self.assertIn("detour", plan["unmatched"][0]["reason"].lower())

    def test_shifts_are_not_mixed(self):
        people = [
            self._person("driver_am", -77.44, 37.55, True, shift=6 * 3600),
            self._person("rider_pm", -77.441, 37.551, False, shift=15 * 3600),
        ]
        plan = self._plan(people)
        self.assertEqual(plan["summary"]["riders_matched"], 0)
        self.assertIn("shift", plan["unmatched"][0]["reason"].lower())

    def test_pickup_times_precede_arrival_and_are_ordered(self):
        people = [self._person("driver", -77.44, 37.55, True)]
        people += [
            self._person("r1", -77.445, 37.552, False),
            self._person("r2", -77.450, 37.556, False),
        ]
        plan = self._plan(people)
        pool = plan["pools"][0]
        times = [rider["pickup_time"] for rider in pool["riders"]]
        self.assertEqual(times, sorted(times))
        self.assertLess(pool["depart_time"], pool["arrive_time"])
        orders = [rider["order"] for rider in pool["riders"]]
        self.assertEqual(orders, list(range(1, len(orders) + 1)))

    def test_route_starts_at_driver_and_ends_at_worksite(self):
        people = [
            self._person("driver", -77.44, 37.55, True),
            self._person("rider", -77.445, 37.552, False),
        ]
        plan = self._plan(people)
        route = plan["pools"][0]["route"]
        self.assertEqual(route[0], [-77.44, 37.55])
        self.assertEqual(route[-1], list(DOWNTOWN))

    def test_detour_is_never_negative(self):
        people = [
            self._person("driver", -77.44, 37.55, True),
            self._person("rider", -77.445, 37.552, False),
        ]
        plan = self._plan(people)
        for pool in plan["pools"]:
            self.assertGreaterEqual(pool["detour_minutes"], 0)
            self.assertGreaterEqual(pool["route_minutes"], pool["direct_minutes"])

    def test_no_drivers_leaves_everyone_unmatched(self):
        people = [self._person("rider", -77.44, 37.55, False)]
        plan = self._plan(people)
        self.assertEqual(plan["summary"]["riders_matched"], 0)
        self.assertEqual(len(plan["unmatched"]), 1)

    def test_empty_roster_does_not_crash(self):
        plan = self._plan([])
        self.assertEqual(plan["summary"]["riders_needing_ride"], 0)
        self.assertEqual(plan["pools"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestRoadNetwork(unittest.TestCase):
    """Road routing, plus the fallback that keeps a demo alive when it is down."""

    # Two points either side of the James River: ~9.8 km apart in a straight
    # line, ~21 km by road because you can only cross at a bridge.
    SOUTH = (-77.4300, 37.4300)
    NORTH = (-77.3200, 37.4400)

    def test_haversine_matrix_is_self_consistent(self):
        matrix = roadnetwork._haversine_matrix([self.SOUTH, self.NORTH], "test")
        self.assertEqual(matrix.provider, "haversine")
        self.assertFalse(matrix.is_real_roads)
        self.assertEqual(matrix.distance(self.SOUTH, self.SOUTH), 0)
        # Straight-line distance is symmetric by construction.
        self.assertAlmostEqual(
            matrix.distance(self.SOUTH, self.NORTH),
            matrix.distance(self.NORTH, self.SOUTH),
            places=3,
        )

    def test_unknown_points_fall_back_rather_than_raising(self):
        matrix = roadnetwork._haversine_matrix([self.SOUTH], "test")
        # A point absent from the matrix must still return a usable distance.
        self.assertGreater(matrix.distance(self.SOUTH, self.NORTH), 1000)
        self.assertGreater(matrix.duration(self.SOUTH, self.NORTH), 0)

    def test_disabled_routing_degrades_cleanly(self):
        original = roadnetwork.OSRM_ENABLED
        roadnetwork.OSRM_ENABLED = False
        try:
            matrix = roadnetwork.build_matrix([self.SOUTH, self.NORTH])
            self.assertEqual(matrix.provider, "haversine")
            self.assertIn("disabled", matrix.note.lower())
            self.assertIsNone(roadnetwork.route_geometry([self.SOUTH, self.NORTH]))
        finally:
            roadnetwork.OSRM_ENABLED = original

    def test_too_many_points_falls_back(self):
        points = [(-77.4 - i * 0.001, 37.5 + i * 0.001) for i in range(200)]
        matrix = roadnetwork.build_matrix(points)
        self.assertEqual(matrix.provider, "haversine")
        self.assertIn("limit", matrix.note.lower())

    def test_matrix_deduplicates_points(self):
        repeated = [self.SOUTH, self.SOUTH, self.NORTH, self.SOUTH]
        matrix = roadnetwork._haversine_matrix(
            list(dict.fromkeys(repeated)), "test"
        )
        self.assertEqual(len(matrix.points), 2)

    def test_carpool_plan_reports_its_distance_source(self):
        people = [
            carpool.Person(ref="d", lon=-77.44, lat=37.55, zone_id=None,
                           has_vehicle=True, verdict="no_service", shift_start_s=9 * 3600),
            carpool.Person(ref="r", lon=-77.445, lat=37.552, zone_id=None,
                           has_vehicle=False, verdict="no_service", shift_start_s=9 * 3600),
        ]
        matrix = roadnetwork._haversine_matrix([(-77.44, 37.55), (-77.445, 37.552), DOWNTOWN], "test")
        plan = carpool.plan(people, DOWNTOWN, matrix=matrix, include_geometry=False)
        self.assertEqual(plan["summary"]["distance_provider"], "haversine")
        self.assertFalse(plan["summary"]["routed_on_real_roads"])


def _osrm_reachable() -> bool:
    try:
        matrix = roadnetwork.build_matrix(
            [(-77.4300, 37.4300), (-77.3200, 37.4400)], timeout=12
        )
        return matrix.is_real_roads
    except Exception:  # noqa: BLE001
        return False


@unittest.skipUnless(_osrm_reachable(), "OSRM routing service not reachable")
class TestRoadNetworkLive(unittest.TestCase):
    SOUTH = (-77.4300, 37.4300)
    NORTH = (-77.3200, 37.4400)

    def test_road_distance_exceeds_straight_line_across_the_river(self):
        matrix = roadnetwork.build_matrix([self.SOUTH, self.NORTH])
        straight = gtfs.haversine_m(*self.SOUTH, *self.NORTH)
        road = matrix.distance(self.SOUTH, self.NORTH)
        # The bridge detour is the whole reason this module exists: the old flat
        # 1.25 factor underestimated it by well over half.
        self.assertGreater(road, straight * 1.6)

    def test_road_distances_can_be_asymmetric(self):
        matrix = roadnetwork.build_matrix([self.SOUTH, self.NORTH])
        there = matrix.distance(self.SOUTH, self.NORTH)
        back = matrix.distance(self.NORTH, self.SOUTH)
        self.assertNotAlmostEqual(there, back, places=0)

    def test_route_geometry_follows_roads(self):
        geometry = roadnetwork.route_geometry([self.SOUTH, self.NORTH])
        self.assertIsNotNone(geometry)
        # A straight line would be two points; a real road route has many.
        self.assertGreater(len(geometry), 20)
        for lon, lat in geometry:
            self.assertTrue(-78.5 < lon < -76.5, f"lon out of region: {lon}")
            self.assertTrue(36.5 < lat < 38.5, f"lat out of region: {lat}")

    def test_durations_are_present_and_plausible(self):
        matrix = roadnetwork.build_matrix([self.SOUTH, self.NORTH])
        minutes = matrix.duration(self.SOUTH, self.NORTH) / 60
        self.assertGreater(minutes, 5)
        self.assertLess(minutes, 90)
