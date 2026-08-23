"""Decide whether a specific commute is actually viable on public transit.

This is the bridge between the county-wide access map and the carpool side of
the product. The map shows where transit reaches in general; this answers the
question an individual actually has - "can *I* get to *this* job for *this*
shift?" - and when the answer is no, it says precisely why. That reason is what
justifies routing someone into a carpool.

Thresholds are deliberately explicit and conservative rather than tuned, so the
verdict can be defended and adjusted:

  gap           no service at all, or > 60 min each way, or 3+ transfers,
                or a departure before 05:00, or no way home after the shift
  marginal      45-60 min, or exactly 2 transfers
  microtransit  fixed routes fail, but GRTC LINK covers the trip on demand
  viable        everything else
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from . import microtransit
from .gtfs import Feed, format_seconds, haversine_m
from .transit_router import (
    DEFAULT_MAX_WALK_M,
    BackwardScan,
    Journey,
    plan_arrive_by,
    plan_depart_after,
)

# Thresholds, in minutes unless noted.
VIABLE_MAX_MINUTES = 45
GAP_MIN_MINUTES = 60
MARGINAL_TRANSFERS = 2
GAP_TRANSFERS = 3
EARLIEST_REASONABLE_DEPARTURE_S = 5 * 3600

# Crude driving comparison: straight-line at 45 km/h plus 5 minutes of parking
# and local streets. Used only for the "transit takes N times longer" ratio.
DRIVE_SPEED_MPS = 12.5
DRIVE_OVERHEAD_S = 300

# GRTC runs an Open Access system: no fare is charged on fixed routes, the Pulse
# or LINK microtransit. https://www.ridegrtc.com/
TRANSIT_FARE_USD = 0.0
# IRS standard mileage rate, the usual proxy for the all-in cost of running a
# car (fuel, insurance, maintenance, depreciation). Not just petrol.
COST_PER_MILE_USD = 0.70
METRES_PER_MILE = 1609.34
WORK_DAYS_PER_MONTH = 21


@dataclass
class Verdict:
    status: str  # "viable" | "marginal" | "microtransit" | "gap" | "no_service"
    reasons: list[str] = field(default_factory=list)
    codes: list[str] = field(default_factory=list)

    def add(self, code: str, message: str) -> None:
        if code not in self.codes:
            self.codes.append(code)
            self.reasons.append(message)


def driving_cost(origin: tuple[float, float], destination: tuple[float, float]) -> dict:
    """What the same commute costs by car, against a fare-free bus.

    The affordability gap is the whole argument: for a household without a car,
    the barrier is not the bus fare - there isn't one - it is the $10,000-a-year
    cost of owning the car the bus cannot replace.
    """
    one_way_m = haversine_m(origin[0], origin[1], destination[0], destination[1]) * 1.25
    round_trip_miles = 2 * one_way_m / METRES_PER_MILE
    per_day = round_trip_miles * COST_PER_MILE_USD
    return {
        "transit_fare_usd": TRANSIT_FARE_USD,
        "transit_note": "GRTC charges no fare on buses, the Pulse or LINK.",
        "drive_round_trip_miles": round(round_trip_miles, 1),
        "drive_cost_per_day_usd": round(per_day, 2),
        "drive_cost_per_month_usd": round(per_day * WORK_DAYS_PER_MONTH, 2),
        "drive_cost_per_year_usd": round(per_day * WORK_DAYS_PER_MONTH * 12),
        "cost_basis": f"IRS standard mileage rate, ${COST_PER_MILE_USD:.2f}/mile, round trip",
    }


def drive_estimate_minutes(origin: tuple[float, float], destination: tuple[float, float]) -> int:
    distance = haversine_m(origin[0], origin[1], destination[0], destination[1])
    return max(5, round((distance * 1.25 / DRIVE_SPEED_MPS + DRIVE_OVERHEAD_S) / 60))


@dataclass
class StopProximity:
    """How far the nearest boarding point is from each end of the trip."""

    origin_nearest_m: float | None
    origin_nearest_name: str | None
    destination_nearest_m: float | None
    destination_nearest_name: str | None
    max_walk_m: float

    @property
    def origin_stranded(self) -> bool:
        return self.origin_nearest_m is None or self.origin_nearest_m > self.max_walk_m

    @property
    def destination_stranded(self) -> bool:
        return self.destination_nearest_m is None or self.destination_nearest_m > self.max_walk_m

    def as_dict(self) -> dict:
        return {
            "origin_nearest_stop_m": round(self.origin_nearest_m)
            if self.origin_nearest_m is not None
            else None,
            "origin_nearest_stop": self.origin_nearest_name,
            "destination_nearest_stop_m": round(self.destination_nearest_m)
            if self.destination_nearest_m is not None
            else None,
            "destination_nearest_stop": self.destination_nearest_name,
            "max_walk_m": round(self.max_walk_m),
        }


def stop_proximity(
    feed: Feed,
    origin: tuple[float, float],
    destination: tuple[float, float],
    max_walk_m: float,
) -> StopProximity:
    """Distance to the nearest stop at each end, searching well beyond max walk.

    Knowing *why* there is no service matters: a workplace with no stop within a
    mile is a land-use problem that only a carpool or shuttle fixes, whereas a
    workplace with stops but no early-morning bus is a scheduling problem.
    """
    search_radius = max(max_walk_m * 5, 5000)

    def nearest(point):
        found = feed.stops_near(point[0], point[1], search_radius)
        if not found:
            return None, None
        stop, distance = found[0]
        return distance, stop.name

    origin_m, origin_name = nearest(origin)
    dest_m, dest_name = nearest(destination)
    return StopProximity(origin_m, origin_name, dest_m, dest_name, max_walk_m)


def classify(
    outbound: Journey | None,
    inbound: Journey | None,
    origin: tuple[float, float],
    destination: tuple[float, float],
    needs_return: bool,
    proximity: StopProximity | None = None,
) -> Verdict:
    verdict = Verdict(status="viable")

    if outbound is None:
        verdict.status = "no_service"
        if proximity is not None and proximity.destination_stranded:
            distance = proximity.destination_nearest_m
            verdict.add(
                "no_stop_near_destination",
                f"There is no bus stop within walking distance of the workplace - "
                f"the nearest is {round(distance):,} m away"
                f" ({'about ' + str(round(distance * 1.35 / 1.33 / 60)) + ' min walk' if distance else ''})."
                if distance
                else "There is no bus stop anywhere near the workplace.",
            )
        if proximity is not None and proximity.origin_stranded:
            distance = proximity.origin_nearest_m
            verdict.add(
                "no_stop_near_origin",
                f"There is no bus stop within walking distance of home - "
                f"the nearest is {round(distance):,} m away."
                if distance
                else "There is no bus stop anywhere near home.",
            )
        if not verdict.codes:
            verdict.add(
                "no_service_at_hour",
                "Bus stops serve both ends, but no scheduled service connects them "
                "in time for this shift.",
            )
        return verdict

    minutes = round(outbound.duration_s / 60)
    transfers = outbound.transfers

    if minutes > GAP_MIN_MINUTES:
        verdict.status = "gap"
        verdict.add("too_long", f"The trip takes {minutes} minutes each way.")
    elif minutes > VIABLE_MAX_MINUTES:
        verdict.status = "marginal"
        verdict.add("long", f"The trip takes {minutes} minutes each way.")

    if transfers >= GAP_TRANSFERS:
        verdict.status = "gap"
        verdict.add("many_transfers", f"It requires {transfers} transfers.")
    elif transfers == MARGINAL_TRANSFERS and verdict.status == "viable":
        verdict.status = "marginal"
        verdict.add("transfers", "It requires 2 transfers.")

    if outbound.depart_s < EARLIEST_REASONABLE_DEPARTURE_S:
        verdict.status = "gap"
        verdict.add(
            "early_departure",
            f"You would have to leave home at {format_seconds(outbound.depart_s)}.",
        )

    if needs_return and inbound is None:
        verdict.status = "gap"
        verdict.add(
            "no_return",
            "There is no transit service home after the shift ends.",
        )
    elif needs_return and inbound is not None:
        return_minutes = round(inbound.duration_s / 60)
        if return_minutes > GAP_MIN_MINUTES:
            verdict.status = "gap"
            verdict.add(
                "return_too_long",
                f"The trip home takes {return_minutes} minutes.",
            )
        wait = inbound.depart_s
        # A long wait for the first bus home after a shift ends is its own barrier.
        if wait is not None:
            verdict.add(
                "return_info",
                f"First bus home departs {format_seconds(inbound.depart_s)}, "
                f"arriving {format_seconds(inbound.arrive_s)}.",
            )

    if verdict.status == "viable" and not verdict.reasons:
        verdict.add(
            "ok",
            f"Transit works: {minutes} minutes, "
            f"{transfers} transfer{'s' if transfers != 1 else ''}.",
        )
    return verdict


def evaluate(
    feed: Feed,
    origin: tuple[float, float],
    destination: tuple[float, float],
    shift_start_s: int,
    shift_end_s: int | None,
    day: date,
    max_walk_m: float = DEFAULT_MAX_WALK_M,
    origin_name: str = "Home",
    destination_name: str = "Workplace",
    scan: BackwardScan | None = None,
) -> dict:
    """Full commute assessment in both directions, with a verdict."""
    outbound = plan_arrive_by(
        feed,
        origin,
        destination,
        shift_start_s,
        day,
        max_walk_m,
        origin_name,
        destination_name,
        scan=scan,
    )

    inbound = None
    if shift_end_s is not None:
        inbound = plan_depart_after(
            feed,
            destination,
            origin,
            shift_end_s,
            day,
            max_walk_m,
            destination_name,
            origin_name,
        )

    proximity = stop_proximity(feed, origin, destination, max_walk_m)
    verdict = classify(
        outbound, inbound, origin, destination, shift_end_s is not None, proximity
    )

    # LINK microtransit is fare-free GRTC service that the GTFS feed omits, so it
    # has to be checked separately - otherwise the planner tells people in Elko
    # and Varina they have no option when GRTC will collect them from home.
    link_options = microtransit.evaluate_options(
        origin,
        destination,
        day,
        outbound.depart_s if outbound else shift_start_s - 3600,
        shift_start_s,
    )
    door_to_door = next(
        (option for option in link_options if option["kind"] == "door_to_door" and option["available"]),
        None,
    )
    connection = next(
        (option for option in link_options if option["kind"] != "door_to_door" and option["available"]),
        None,
    )

    if door_to_door and verdict.status in ("gap", "no_service"):
        # Fixed routes fail, but LINK covers the whole trip on demand. Reporting
        # this as "no service" would be simply false.
        verdict.status = "microtransit"
        verdict.add("link_door_to_door", door_to_door["headline"] + ".")
    elif connection and verdict.status in ("gap", "no_service"):
        verdict.add(
            "link_connection",
            connection["headline"]
            + ". The planner cannot verify the combined LINK-plus-bus timing, so check it in the app.",
        )

    drive_minutes = drive_estimate_minutes(origin, destination)
    transit_minutes = round(outbound.duration_s / 60) if outbound else None

    return {
        "verdict": verdict.status,
        "reasons": verdict.reasons,
        "codes": verdict.codes,
        "shift": {
            "start": format_seconds(shift_start_s),
            "end": format_seconds(shift_end_s) if shift_end_s is not None else None,
            "day": day.isoformat(),
            "day_name": day.strftime("%A"),
        },
        "outbound": outbound.as_dict() if outbound else None,
        "inbound": inbound.as_dict() if inbound else None,
        "stop_access": proximity.as_dict(),
        "microtransit": link_options,
        "has_microtransit_option": bool(door_to_door or connection),
        "comparison": {
            "transit_minutes": transit_minutes,
            "drive_estimate_minutes": drive_minutes,
            "transit_penalty": round(transit_minutes / drive_minutes, 1)
            if transit_minutes and drive_minutes
            else None,
            "straight_line_km": round(
                haversine_m(origin[0], origin[1], destination[0], destination[1]) / 1000, 1
            ),
        },
        "cost": driving_cost(origin, destination),
        # Somebody LINK can carry door to door already has a ride.
        "carpool_recommended": verdict.status in ("gap", "no_service"),
    }
