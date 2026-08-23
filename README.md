# CrossTown

A transportation access platform for **Henrico County, VA**.

The problem: people without a car are cut off from work. Not because the county
has no bus system, but because the bus system does not reach the places and hours
that jobs actually exist in. CrossTown measures that gap precisely, then treats
it as the starting point for organising rides rather than the end of the story.

Layers, each building on the one below:

| Layer | Question it answers | Status |
| --- | --- | --- |
| **Access map** | Where does transit reach across the county at all? | Built |
| **Commute check** | Can *this* person reach *this* job for *this* shift? | Built |
| **On-demand (LINK)** | Is there fare-free microtransit where no bus goes? | Built |
| **Employer report** | How many of my staff cannot get here, and why? | Built |
| **Carpool planner** | Who can ride with whom, leaving when? | Built |
| **Accounts & messaging** | Verified organisations, opt-in, contact exchange | Designed — see [Roadmap](#roadmap) |

The bus network is one input, not the product. The map's job is to prove the gap;
the gap's job is to justify the ride.

- **Backend:** FastAPI + a pure-Python GTFS transit router (no JVM, no OSM extract)
- **Spatial:** optional PostgreSQL/PostGIS, falls back to committed GeoJSON
- **Frontend:** MapLibre GL JS + Tailwind CSS, ES modules
- **Data:** live GRTC GTFS feed, ACS table B25044, 130 grid nodes, 437 destinations,
  243 Census block groups

### What the data shows

Measured with the code in this repository, against the GRTC schedule published
2026-07-01:

- **Innsbrook office park** — one of the county's largest employment centres — has
  **no bus stop within 1.4 km**. No shift is reachable by transit, at any hour.
- Large parts of eastern Henrico (Varina, Elko, Sandston) have **no fixed bus route
  at all**, but GRTC does run fare-free on-demand LINK vans there. Because LINK is
  missing from the GTFS feed, a schedule-only planner reports "no service" — the
  worst possible wrong answer for the people this project is about.
- A **6am shift in the Short Pump retail corridor** is unreachable from downtown
  Richmond: stops serve both ends, but no bus runs early enough.
- Of a 60-person roster distributed by where car-free households actually live,
  **59 cannot reach Short Pump on transit**; 26 of them own no car.
- Those 26 stranded riders can be matched to colleagues already driving:
  **24 of 26 get a ride across 13 carpools, at a mean detour of 8.6 minutes** —
  112 minutes of total added driving to move 24 people who otherwise cannot work.
  (Routed on real roads. A straight-line model claimed 25 riders at 5.4 minutes;
  it was quietly ignoring the James River.)
- County-wide, **26.2% of car-free households** sit in the lowest-access areas,
  and 85% of grid nodes cannot reach a library within 45 minutes.

---

## Quick start (no database required)

The processed datasets are committed under `Data/Processed`, so the API can
serve them directly. This is the fastest way to get the map on screen.

```bash
python3 -m venv venv
source venv/bin/activate           # Windows: .\venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Start the API from the repository root:

```bash
uvicorn Backend.main:app --reload
```

Then serve the frontend (a static server is required — opening `index.html` via
`file://` breaks the API calls because of CORS):

```bash
python3 Frontend/dev_server.py
```

Open <http://127.0.0.1:5500>. Interactive API docs live at
<http://127.0.0.1:8000/docs>, and <http://127.0.0.1:8000/api/v1/health> reports
which data backend is live.

Use `dev_server.py` rather than `python -m http.server`: it sends `Cache-Control:
no-store`. Plain `http.server` sends no cache headers at all, so browsers hold on
to the ES modules under `Frontend/js/` for the life of the tab — you edit a file,
reload, and the browser quietly runs the old one. VS Code's Live Server extension
also works and serves on port 5500, which is already in the API's CORS allow-list.

---

## Optional: PostGIS backend

```sql
CREATE DATABASE crosstown;
\c crosstown;
CREATE EXTENSION postgis;
```

Then configure credentials and ingest:

```bash
cp .env.example .env      # fill in CROSSTOWN_DB_PASSWORD
pip install geopandas SQLAlchemy psycopg2-binary
python -m Backend.load_to_postgis
```

The API picks up PostGIS automatically when `.env` is configured, and silently
falls back to the processed files if the database is unreachable. Credentials are
read from the environment only — never hard-code them in source.

---

## API

`/api/v1` describes the county. `/api/v2` answers questions about specific trips.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Active data backend and score calibration |
| `GET` | `/api/v1/grid` | Access grid GeoJSON with 0–100 scores per node |
| `GET` | `/api/v1/demographics` | Census block groups with car-free household share |
| `GET` | `/api/v1/destinations` | Amenity points, optional `?category=Food` |
| `GET` | `/api/v1/stats` | County summary + car-free equity crosstab |
| `GET` | `/api/v1/node/{id}` | Scores for one grid node |
| `POST` | `/api/v1/reachability` | Geocode an address → nearest node scores |
| `GET` | `/api/v2/transit/health` | GTFS feed window, size, routing assumptions |
| `GET` | `/api/v2/transit/stops` | All bus stops as GeoJSON |
| `GET` | `/api/v2/microtransit/zones` | GRTC LINK on-demand zones with today's hours |
| `POST` | `/api/v2/commute` | One trip: itinerary both ways + gap verdict |
| `POST` | `/api/v2/roster/gaps` | A whole roster vs one worksite + carpool clusters |
| `POST` | `/api/v2/carpool/plan` | Match stranded staff to drivers; routes and pickup times |
| `GET` | `/api/v2/demo/roster` | The synthetic roster used by the demo |

### On-demand microtransit (GRTC LINK)

`Backend/microtransit.py` adds the six GRTC LINK zones — Sandston, Azalea, Broad
Rock, Ashland, Clover Dale and Powhatan. LINK is on-demand: book in the GRTC On
the Go app or by phone, a van arrives in about 20 minutes (60 in Powhatan), and it
carries you anywhere inside the zone, including to a connecting bus stop. No fare.

This exists because **LINK is not in the GTFS feed**, which carries fixed routes
only. Without it the planner told anyone in Varina or Elko they had no way to
work. The planner now reports three shapes of option — LINK covering the whole
trip inside one zone, LINK as a first-mile connection to a bus, and LINK as the
last leg — and a trip LINK can do door-to-door gets its own verdict rather than
being lumped in with "no service".

Zone boundaries are **approximate**: GRTC publishes zone maps as images, not open
data, so the polygons are drawn from the published service-area descriptions.
Every surface that shows them says so, and hours are resolved per service day.

### Fares and the real cost of a commute

GRTC runs an Open Access system: **no fare on buses, the Pulse, or LINK.** So the
honest comparison is not bus fare versus petrol, it is free versus the cost of
owning the car the bus cannot replace. `Backend/commute.py` prices the same trip
by car at the IRS standard mileage rate, which is what makes the equity argument
concrete — a Varina-to-Short-Pump commute is **$0 by transit or $9,488 a year to
drive**, for a household that by definition cannot afford the car.

### How carpool matching works

`Backend/carpool.py` solves a capacitated pickup problem with cheapest insertion:

1. **Riders** are staff with no vehicle whose transit commute is a gap. **Drivers**
   are colleagues on the same shift already driving to the same site — a seat
   costs them a detour, not a trip. Someone with a car is never counted as
   stranded, even when their own transit verdict is a gap.
2. Seed each driver with the direct route `home → worksite`.
3. Place riders **most-constrained-first** (fewest drivers who could reach them
   inside the detour cap), so the hardest people to serve get placed while seats
   remain.
4. Insert each rider at the point in a driver's route that adds the least
   distance, respecting seat capacity and the maximum detour.

Pickup times are computed backwards from shift start, including a 2-minute dwell
per stop. Shifts are matched separately — a driver on the 6am shift is no use to
a rider starting at 3pm.

This is a greedy heuristic, not an optimal vehicle-routing solution. It is
deterministic and produces routes a human can sanity-check, which matters more
here than the last few percent of efficiency.

### Road distances, and why they matter here

Distances and drive times come from real road routing (`Backend/roadnetwork.py`),
not straight lines. Around Richmond that is not a refinement, it is a correctness
issue: **the James River splits the county and you can only cross it at a
bridge.** Two points 9.8 km apart in a straight line are 21.1 km apart by road —
the old flat 1.25 factor underestimated that detour by **1.73×**, so the matcher
would seat a rider "on the way" when the driver would in fact cross the river
twice. Road distances are also *asymmetric* (21,137 m out, 21,527 m back on that
pair, because of one-way streets), which a symmetric model cannot express at all.

Switching to real roads changed the demo result honestly: **25 riders matched
across 16 pools at a claimed 5.4-minute mean detour became 24 riders across 13
pools at 8.6 minutes.** The old numbers were flattering, not accurate.

One OSRM `/table` request returns the full matrix for a whole plan, and points
are deduplicated first — employees share grid zones, so a 60-person roster
collapses to about 25 distinct pickup points. The same routing supplies the road
polylines the map draws, fetched concurrently (sequentially this was 17 seconds
on a cold cache; it is now under 3) and cached to disk under `Data/Cache/`.

**It degrades safely.** If the routing service is unreachable, rate limited, or
the point set is too large for one request, everything falls back to the old
straight-line model and says so — in the API as `summary.distance_provider`, and
in the UI as a visible note. A demo must never fail because a public server is
busy. Set `CROSSTOWN_OSRM_URL` to use your own OSRM instance, or
`CROSSTOWN_OSRM_DISABLED=1` to force the offline model.

### How the transit router works

`Backend/transit_router.py` implements the Connection Scan Algorithm directly over
the GTFS feed, in about 300 lines of standard-library Python. Two single-pass
scans:

- **Backward** — "to arrive by 08:00, how late can I leave each stop?" One scan
  answers this for all 1,596 stops simultaneously, which is why a 60-person roster
  analysis costs roughly the same as two individual lookups.
- **Forward** — "leaving at 06:42, when do I arrive?" Used to reconstruct the
  leg-by-leg itinerary once the departure time is known.

`transfers.txt` is empty in the GRTC feed, so walking transfers between stops
within 250 m are generated at load time. Without them almost every cross-town
journey would look impossible.

This deliberately replaces r5py for trip-level routing. r5py needs a JVM and a
400 MB Virginia OSM extract; the GTFS feed is 4 MB and indexes in about a second,
which is what makes live queries practical. r5py is still used to build the
county-wide accessibility grid, where its street-network routing earns its cost.

**Stated approximations.** Walking uses straight-line distance × 1.35 at 4.8 km/h
— there is no pedestrian network, so a walk crossing a highway or river is
underestimated. Bus-to-bus transfers assume 3 minutes. Schedules are as published;
real-time delays are not modelled.

### Gap thresholds

| Verdict | Meaning |
| --- | --- |
| `viable` | Under 45 min each way, at most 1 transfer |
| `marginal` | 45–60 min, or exactly 2 transfers |
| `gap` | Over 60 min, 3+ transfers, departure before 05:00, or no way home |
| `no_service` | No route at all — distinguishing *no stop nearby* from *no bus at that hour* |

That last distinction matters: a worksite with no stop within a mile is a land-use
problem only a carpool or shuttle fixes, whereas a worksite with stops but no
early bus is a scheduling problem worth raising with GRTC.

### How scores work

Raw counts of reachable destinations are normalised to 0–100 against the **95th
percentile** of the grid itself (see `Backend/scoring.py`), so scores are
relative to the rest of the county rather than to an absolute standard. A count
of zero scores zero — the score is never back-filled from a category average.

---

## Data pipeline

Raw inputs live in `Data/Raw`. The two large files are gitignored and must be
downloaded separately into `Data/Raw/`:

- `gtfs.zip` — the GRTC feed, **required** for the commute check and employer
  dashboard. Fetch it with:

  ```bash
  curl -L -o Data/Raw/gtfs.zip https://www.ridegrtc.com/wp-content/uploads/2025/02/gtfs.zip
  ```

  The URL comes from GRTC via [Transitland](https://www.transit.land/feeds/f-grtc~va).
  `GET /api/v2/transit/health` reports the loaded feed's validity window; when it
  expires, re-download.

- `virginia-latest.osm.pbf` — [Geofabrik](https://download.geofabrik.de/north-america/us/virginia.html).
  Only needed to *rebuild* the accessibility grid with r5py; the committed grid
  works without it.

Run in order from the repository root:

```bash
python -m Backend.build_destinations    # raw assets  -> destinations.csv
python -m Backend.routing_engine        # r5py        -> travel_time_matrix.csv
python -m Backend.calculate_scores      # matrix      -> access_grid_final.geojson
python -m Backend.process_census        # ACS B25044  -> census_carfree.geojson
python -m Backend.load_to_postgis       # optional: GeoJSON -> PostGIS
```

Every script resolves paths from the repository root, so they behave the same
regardless of the directory you invoke them from.

### Known data-quality issue

`Data/Raw/Assets/Grocery_stores.geojson` is an Overpass extract that matched on
name, so it includes 54 road segments (`highway=residential`, e.g. "New Market
Road" 39 times) plus assorted non-food shops. Because Food is the largest
category it dominates `access_score`, meaning the committed
`access_grid_final.geojson` is inflated.

`Backend/build_destinations.py` applies explicit tag filters and drops 112 of the
302 Food rows. Preview without writing anything:

```bash
python -m Backend.build_destinations --dry-run
```

Writing a corrected `destinations.csv` requires re-running `routing_engine.py`
and `calculate_scores.py` (which need the OSM extract and GTFS feed) for the grid
to match. Pass `--include-recreation` to also fold in the 65 athletic-court
polygons — currently downloaded but unused — as a fifth category.

---

## Testing

```bash
python -m unittest discover -s tests -v
```

73 tests. `tests/test_crosstown.py` covers the routing maths, service-calendar
handling (including the Labor Day exception), gap classification, microtransit
zones, road routing and carpool matching — all against the real GTFS feed, no
mocks. Carpool matching is tested against an explicit straight-line matrix so the
heuristic is verified deterministically and offline; live road routing has its
own tests that skip themselves when the service is unreachable.
`tests/test_api.py` exercises every endpoint end to end and skips itself with a
clear message when the API is not running.

The suite asserts on behaviour that has actually broken before: that a genuine
zero is never replaced by an invented score, that the census layer is not
placeholder data, that every roster employee lands in exactly one verdict bucket,
and that every rider is either matched or explained.

---

## Repository layout

```
CrossTown/
├── Backend/
│   ├── config.py              # paths + env-based settings
│   ├── scoring.py             # 0-100 normalisation (single source of truth)
│   ├── datasource.py          # PostGIS or GeoJSON-file backend
│   ├── main.py                # FastAPI app (/api/v1)
│   ├── api_transit.py         # commute + roster endpoints (/api/v2)
│   ├── gtfs.py                # GTFS feed loader and indexer
│   ├── transit_router.py      # Connection Scan Algorithm journey planner
│   ├── commute.py             # gap classification and verdicts
│   ├── build_destinations.py  # raw assets -> destinations.csv
│   ├── routing_engine.py      # r5py travel-time matrix
│   ├── calculate_scores.py    # matrix -> scored access grid
│   ├── load_to_postgis.py     # GeoJSON -> PostGIS
│   ├── process_census.py      # ACS B25044 -> car-free layer
│   ├── carpool.py             # rider/driver matching and route building
│   ├── microtransit.py        # GRTC LINK on-demand zones
│   ├── roadnetwork.py         # OSRM road distances, routes, and fallback
│   ├── fetch_gtfs.py          # download + validate the GRTC feed
│   └── make_demo_roster.py    # synthetic roster for the employer demo
├── Frontend/
│   ├── index.html
│   ├── style.css
│   ├── dev_server.py          # static server with caching disabled
│   └── js/
│       ├── main.js            # app shell, view switching, keyboard control
│       ├── map.js             # shared MapLibre instance
│       ├── api.js             # fetch helpers
│       ├── ui.js              # status pills, toasts, skeletons, CSV export
│       ├── linkzones.js       # LINK on-demand zone layer
│       ├── roster.js          # demo roster shared across views
│       ├── access.js          # county access map view
│       ├── commute.js         # commute check view
│       ├── employer.js        # employer gap dashboard view
│       └── carpool.js         # carpool planner view
├── tests/
│   ├── test_crosstown.py      # routing, scoring, microtransit, carpool
│   └── test_api.py            # every endpoint, end to end
├── Data/
│   ├── Raw/                   # Census, Assets, Transit/link_zones.geojson
│   ├── Processed/             # committed GeoJSON + CSV outputs
│   └── Demo/                  # synthetic roster (clearly labelled)
├── requirements.txt
└── .env.example
```

---

## Roadmap

The matching engine works; the trust layer around it does not exist yet. The
planner currently proposes rides between rows in a spreadsheet. Turning those into
contact between real people needs everything below, and these are the load-bearing
decisions:

**Verified organisations, not just employers.** An organisation is any institution
with an existing trusted relationship to its people — an employer, a school, a
youth programme, a clinic. Employer is simply the first type. This keeps students
in scope without special-casing them.

**Verification is attestation, not document upload.** An organisation admin
confirms that a person belongs. No driver's licence images are ever stored: a
named manager with accountability is stronger evidence than a photo, and a breach
then exposes no government IDs. Real KYC sits behind an interface with a mock
implementation.

**Organisation-scoped visibility.** You can only see or message people who share
a verified organisation with you. There is no global stranger matching. This single
constraint removes most of the abuse surface in a ride-matching product.

**Coarse locations only.** Pickup points are access grid nodes and public
landmarks, never home addresses — the rule the demo roster already follows.

**Adults first; minors gated by design.** v1 matches verified members 18+. Youth
matching requires guardian consent on file and an approved-driver list, mediated
by the organisation. Open matching for minors is never enabled.

Still to build: Postgres schema and migrations, magic-link auth, organisation and
membership models, admin verification queue, rider/driver opt-in on proposed
matches, organisation-scoped messaging, report/block, and an audit log. The
matching itself (`Backend/carpool.py`) is done and needs only real memberships in
place of the demo roster.

---

## Team workflow

Pull before starting work:

```bash
git pull origin main
```

Do not commit `.env`, the `venv/` folder, or large raw downloads (`.pbf`,
`.zip`) — `.gitignore` already covers them.
