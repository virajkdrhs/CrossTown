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
efficiency.

Distances and drive times come from real road routing (see roadnetwork.py), which
matters more here than it sounds: the James River splits the county, and a
straight-line model priced a two-bridge detour as if the driver could swim. Where
routing is unavailable everything degrades to the old straight-line estimate and
says so in ``summary.distance_provider``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from . import roadnetwork
from .gtfs import format_seconds, haversine_m

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


def _route_distance(matrix, points: list[tuple[float, float]]) -> float:
    return sum(matrix.distance(points[i], points[i + 1]) for i in range(len(points) - 1))


def _route_seconds(matrix, points: list[tuple[float, float]], pickups: int) -> int:
    """Driving time along a route, plus the time spent stopped for each pickup."""
    driving = sum(matrix.duration(points[i], points[i + 1]) for i in range(len(points) - 1))
    return int(driving) + pickups * PICKUP_DWELL_S


def plan(
    people: list[Person],
    worksite: tuple[float, float],
    seats_per_driver: int = DEFAULT_SEATS,
    max_detour_min: int = DEFAULT_MAX_DETOUR_MIN,
    matrix=None,
    include_geometry: bool = True,
) -> dict:
    """Build carpool proposals for one worksite.

    People are grouped by shift first: a driver on the 6am shift is no use to a
    rider starting at 3pm.
    """
    max_detour_s = max_detour_min * 60

    if matrix is None:
        # One routing call covers every driver, rider and the worksite. Employees
        # share grid zones, so the point set collapses well below the roster size.
        matrix = roadnetwork.build_matrix(
            [(person.lon, person.lat) for person in people] + [worksite]
        )

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
            rider_point = (rider.lon, rider.lat)
            for driver in drivers:
                driver_point = (driver.lon, driver.lat)
                base = matrix.duration(driver_point, worksite)
                via = matrix.duration(driver_point, rider_point) + matrix.duration(
                    rider_point, worksite
                )
                if (via - base) + PICKUP_DWELL_S <= max_detour_s:
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
                base_seconds = _route_seconds(matrix, base_points, len(pool.sequence))
                direct_seconds = matrix.duration((driver.lon, driver.lat), worksite)

                for position in range(1, len(base_points)):
                    candidate = list(base_points)
                    candidate.insert(position, (rider.lon, rider.lat))
                    candidate_seconds = _route_seconds(matrix, candidate, len(pool.sequence) + 1)
                    # Cost the insertion in the driver's time, which is what they
                    # actually agree to give up.
                    added = candidate_seconds - base_seconds
                    detour_s = candidate_seconds - direct_seconds
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
            pools.append(_describe(pool, worksite, shift_start, matrix))
            total_detour_s += pools[-1]["detour_minutes"] * 60

    if include_geometry and matrix.is_real_roads:
        _attach_geometry(pools)

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
            "distance_provider": matrix.provider,
            "distance_note": matrix.note,
            "routed_on_real_roads": matrix.is_real_roads,
        },
    }


def _attach_geometry(pools: list[dict]) -> None:
    """Fetch every pool's road polyline at once.

    Sequentially this was 13 round trips and about 17 seconds on a cold cache -
    long enough to look broken during a demo. A small thread pool brings it under
    two seconds, and the on-disk cache makes repeat runs instant. Failures leave
    route_geometry as None and the map falls back to straight lines.
    """
    if not pools:
        return
    from concurrent.futures import ThreadPoolExecutor  # noqa: PLC0415

    def fetch(pool):
        points = [tuple(point) for point in pool["route"]]
        try:
            return roadnetwork.route_geometry(points)
        except Exception:  # noqa: BLE001 - drawing is never worth failing a plan for
            return None

    # Keep the pool small: this is a shared public routing service.
    with ThreadPoolExecutor(max_workers=6) as executor:
        for pool, geometry in zip(pools, executor.map(fetch, pools)):
            pool["route_geometry"] = geometry


def _describe(
    pool: Pool,
    worksite: tuple[float, float],
    shift_start_s: int,
    matrix,
) -> dict:
    points = pool.stops(worksite)
    driver_point = (pool.driver.lon, pool.driver.lat)
    route_distance = _route_distance(matrix, points)
    direct_distance = matrix.distance(driver_point, worksite)
    route_seconds = _route_seconds(matrix, points, len(pool.sequence))
    direct_seconds = int(matrix.duration(driver_point, worksite))
    detour_seconds = max(0, route_seconds - direct_seconds)

    # Work backwards from the shift start so every pickup gets a real clock time.
    arrive_s = shift_start_s - ARRIVAL_BUFFER_S
    depart_s = arrive_s - route_seconds

    legs = []
    clock = depart_s
    for index, rider in enumerate(pool.sequence):
        clock += int(matrix.duration(points[index], points[index + 1]))
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
        "direct_minutes": round(direct_seconds / 60),
        "detour_minutes": round(detour_seconds / 60),
        "route_km": round(route_distance / 1000, 1),
        "direct_km": round(direct_distance / 1000, 1),
        "route": [list(point) for point in points],
        # Filled in by _attach_geometry once every pool is known, so the road
        # polylines can be fetched concurrently rather than one at a time.
        "route_geometry": None,
    }
