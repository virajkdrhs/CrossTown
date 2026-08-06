"""Match stranded staff to colleagues who already drive to the same worksite.

This is the step that turns the gap report into a plan. The employer dashboard
can already say "59 of your 60 staff cannot reach this site on transit"; this
module answers the next question - *who can ride with whom, leaving when, and at
what cost to the driver.*

Who is involved
---------------
* **Rider**  - no vehicle *and* transit cannot cover their commute. These are the
  people the project exists for.
* **Driver** - has a vehicle and is travelling to the same worksite for the same
  shift anyway. Offering a seat costs them a detour, not a trip.

A driver with a car is never counted as stranded, even when their transit verdict
is a gap: they can already get to work.

The algorithm
-------------
A cheapest-insertion heuristic for a capacitated pickup problem:

1. Seed every driver with the direct route ``home -> worksite``.
2. Order riders most-constrained-first (fewest drivers who could reach them
   within the detour cap), so the hardest people to serve are placed while there
   is still capacity.
3. Insert each rider into the position of the route that adds the least distance,
   subject to seat capacity and a maximum total detour.

This is a greedy heuristic, not an optimal vehicle-routing solution. It is
deterministic, runs instantly for a few hundred people, and produces routes a
human can sanity-check - which matters more here than the last few percent of
efficiency. Distances are straight-line scaled by a road-network factor; there is
no turn-by-turn routing.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .gtfs import format_seconds, haversine_m

# Straight-line distance scaled to approximate real road distance.
ROAD_DETOUR_FACTOR = 1.25
DRIVE_SPEED_MPS = 12.5  # ~45 km/h average including local streets

DEFAULT_SEATS = 3
DEFAULT_MAX_DETOUR_MIN = 20
# Time a driver spends stopped for each pickup.
PICKUP_DWELL_S = 120
# Buffer so nobody is scheduled to arrive exactly on the minute.
ARRIVAL_BUFFER_S = 300


@dataclass
class Person:
    ref: str
    lon: float
    lat: float
    zone_id: int | None
    has_vehicle: bool
    verdict: str
    shift_start_s: int
    shift_end_s: int | None = None

    @property
    def needs_ride(self) -> bool:
        return not self.has_vehicle and self.verdict in ("gap", "no_service")


@dataclass
class Pool:
    driver: Person
    riders: list[Person] = field(default_factory=list)
    # Ordered pickup points between the driver's home and the worksite.
    sequence: list[Person] = field(default_factory=list)

    def stops(self, worksite: tuple[float, float]) -> list[tuple[float, float]]:
        points = [(self.driver.lon, self.driver.lat)]
        points.extend((person.lon, person.lat) for person in self.sequence)
        points.append(worksite)
        return points


def _road_distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return haversine_m(a[0], a[1], b[0], b[1]) * ROAD_DETOUR_FACTOR


def _route_distance(points: list[tuple[float, float]]) -> float:
    return sum(_road_distance(points[i], points[i + 1]) for i in range(len(points) - 1))


def _drive_seconds(distance_m: float, pickups: int) -> int:
    return int(distance_m / DRIVE_SPEED_MPS) + pickups * PICKUP_DWELL_S


def plan(
    people: list[Person],
    worksite: tuple[float, float],
    seats_per_driver: int = DEFAULT_SEATS,
    max_detour_min: int = DEFAULT_MAX_DETOUR_MIN,
) -> dict:
    """Build carpool proposals for one worksite.

    People are grouped by shift first: a driver on the 6am shift is no use to a
    rider starting at 3pm.
    """
    max_detour_s = max_detour_min * 60

    by_shift: dict[int, list[Person]] = {}
    for person in people:
        by_shift.setdefault(person.shift_start_s, []).append(person)

    pools: list[dict] = []
    unmatched: list[dict] = []
    total_riders_needing = 0
    total_detour_s = 0

    for shift_start in sorted(by_shift):
        group = by_shift[shift_start]
        drivers = [person for person in group if person.has_vehicle]
        riders = [person for person in group if person.needs_ride]
        total_riders_needing += len(riders)

        if not riders:
            continue
        if not drivers:
            for rider in riders:
                unmatched.append(
                    {
                        "employee_ref": rider.ref,
                        "origin_zone_id": rider.zone_id,
                        "lon": rider.lon,
                        "lat": rider.lat,
                        "shift_start": format_seconds(shift_start),
                        "reason": "No colleague with a vehicle works this shift.",
                    }
                )
            continue

        routes = {driver.ref: Pool(driver=driver) for driver in drivers}

        # Most-constrained-first: count how many drivers could take each rider at
        # all, and place the riders with the fewest options while seats remain.
        def feasible_driver_count(rider: Person) -> int:
            count = 0
            for driver in drivers:
                base = _route_distance([(driver.lon, driver.lat), worksite])
                via = _route_distance(
                    [(driver.lon, driver.lat), (rider.lon, rider.lat), worksite]
                )
                if _drive_seconds(via - base, 1) <= max_detour_s:
                    count += 1
            return count

        ordered = sorted(
            riders,
            key=lambda rider: (
                feasible_driver_count(rider),
                -haversine_m(rider.lon, rider.lat, worksite[0], worksite[1]),
            ),
        )

        for rider in ordered:
            best = None
            for driver in drivers:
                pool = routes[driver.ref]
                if len(pool.sequence) >= seats_per_driver:
                    continue

                base_points = pool.stops(worksite)
                base_distance = _route_distance(base_points)
                direct_distance = _route_distance([(driver.lon, driver.lat), worksite])

                for position in range(1, len(base_points)):
                    candidate = list(base_points)
                    candidate.insert(position, (rider.lon, rider.lat))
                    candidate_distance = _route_distance(candidate)
                    added = candidate_distance - base_distance
                    detour_s = _drive_seconds(
                        candidate_distance - direct_distance, len(pool.sequence) + 1
                    )
                    if detour_s > max_detour_s:
                        continue
                    if best is None or added < best[0]:
                        best = (added, driver.ref, position - 1)

            if best is None:
                unmatched.append(
                    {
                        "employee_ref": rider.ref,
                        "origin_zone_id": rider.zone_id,
                        "lon": rider.lon,
                        "lat": rider.lat,
                        "shift_start": format_seconds(shift_start),
                        "reason": (
                            f"No driver can reach this zone within a {max_detour_min}-minute "
                            "detour, or every nearby driver is full."
                        ),
                    }
                )
                continue

            _, driver_ref, index = best
            pool = routes[driver_ref]
            pool.sequence.insert(index, rider)
            pool.riders.append(rider)

        for driver in drivers:
            pool = routes[driver.ref]
            if not pool.riders:
                continue
            pools.append(_describe(pool, worksite, shift_start))
            total_detour_s += pools[-1]["detour_minutes"] * 60

    matched = sum(len(pool["riders"]) for pool in pools)
    return {
        "pools": sorted(pools, key=lambda pool: -len(pool["riders"])),
        "unmatched": unmatched,
        "summary": {
            "riders_needing_ride": total_riders_needing,
            "riders_matched": matched,
            "riders_unmatched": len(unmatched),
            "pools_formed": len(pools),
            "drivers_used": len({pool["driver"]["employee_ref"] for pool in pools}),
            "pct_matched": round(100 * matched / total_riders_needing, 1)
            if total_riders_needing
            else 0,
            "total_detour_minutes": round(total_detour_s / 60),
            "mean_detour_minutes": round(total_detour_s / 60 / len(pools), 1) if pools else 0,
            "seats_per_driver": seats_per_driver,
            "max_detour_minutes": max_detour_min,
        },
    }


def _describe(pool: Pool, worksite: tuple[float, float], shift_start_s: int) -> dict:
    points = pool.stops(worksite)
    route_distance = _route_distance(points)
    direct_distance = _route_distance([(pool.driver.lon, pool.driver.lat), worksite])
    route_seconds = _drive_seconds(route_distance, len(pool.sequence))
    detour_seconds = _drive_seconds(route_distance - direct_distance, len(pool.sequence))

    # Work backwards from the shift start so every pickup gets a real clock time.
    arrive_s = shift_start_s - ARRIVAL_BUFFER_S
    depart_s = arrive_s - route_seconds

    legs = []
    clock = depart_s
    for index, rider in enumerate(pool.sequence):
        clock += int(_road_distance(points[index], points[index + 1]) / DRIVE_SPEED_MPS)
        legs.append(
            {
                "employee_ref": rider.ref,
                "origin_zone_id": rider.zone_id,
                "lon": rider.lon,
                "lat": rider.lat,
                "pickup_time": format_seconds(clock),
                "order": index + 1,
            }
        )
        clock += PICKUP_DWELL_S

    return {
        "driver": {
            "employee_ref": pool.driver.ref,
            "origin_zone_id": pool.driver.zone_id,
            "lon": pool.driver.lon,
            "lat": pool.driver.lat,
        },
        "riders": legs,
        "seats_used": len(pool.riders),
        "depart_time": format_seconds(depart_s),
        "arrive_time": format_seconds(arrive_s),
        "shift_start": format_seconds(shift_start_s),
        "route_minutes": round(route_seconds / 60),
        "direct_minutes": round(_drive_seconds(direct_distance, 0) / 60),
        "detour_minutes": round(detour_seconds / 60),
        "route_km": round(route_distance / 1000, 1),
        "route": [list(point) for point in points],
    }
