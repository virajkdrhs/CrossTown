# CrossTown

A multi-modal spatial transit accessibility and equity analytics platform for
**Henrico County, VA**. CrossTown measures how many everyday destinations —
groceries, clinics, schools, libraries — a resident can reach on foot and by
transit within a fixed travel-time budget, and cross-references that against
Census data on households without a car.

- **Backend:** FastAPI, optionally PostgreSQL/PostGIS
- **Routing:** r5py (R5) over OpenStreetMap + GTFS
- **Frontend:** MapLibre GL JS + Tailwind CSS
- **Coverage:** 130 origin grid nodes, 437 destinations, 243 Census block groups

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
python3 -m http.server 5500 --directory Frontend
```

Open <http://127.0.0.1:5500>. Interactive API docs live at
<http://127.0.0.1:8000/docs>, and <http://127.0.0.1:8000/api/v1/health> reports
which data backend is live.

VS Code's Live Server extension also works; it serves on port 5500 by default,
which is already in the API's CORS allow-list.

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

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/health` | Active data backend and score calibration |
| `GET` | `/api/v1/grid` | Access grid GeoJSON with 0–100 scores per node |
| `GET` | `/api/v1/demographics` | Census block groups with car-free household share |
| `GET` | `/api/v1/destinations` | Amenity points, optional `?category=Food` |
| `GET` | `/api/v1/stats` | County summary + car-free equity crosstab |
| `GET` | `/api/v1/node/{id}` | Scores for one grid node |
| `POST` | `/api/v1/reachability` | Geocode an address → nearest node scores |

### How scores work

Raw counts of reachable destinations are normalised to 0–100 against the **95th
percentile** of the grid itself (see `Backend/scoring.py`), so scores are
relative to the rest of the county rather than to an absolute standard. A count
of zero scores zero — the score is never back-filled from a category average.

---

## Data pipeline

Raw inputs live in `Data/Raw`. The two large files are gitignored and must be
downloaded separately into `Data/Raw/`:

- `virginia-latest.osm.pbf` — [Geofabrik](https://download.geofabrik.de/north-america/us/virginia.html)
- `gtfs.zip` — GRTC transit feed

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

## Repository layout

```
CrossTown/
├── Backend/
│   ├── config.py              # paths + env-based settings
│   ├── scoring.py             # 0-100 normalisation (single source of truth)
│   ├── datasource.py          # PostGIS or GeoJSON-file backend
│   ├── main.py                # FastAPI app
│   ├── build_destinations.py  # raw assets -> destinations.csv
│   ├── routing_engine.py      # r5py travel-time matrix
│   ├── calculate_scores.py    # matrix -> scored access grid
│   ├── load_to_postgis.py     # GeoJSON -> PostGIS
│   └── process_census.py      # ACS B25044 -> car-free layer
├── Frontend/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── Data/
│   ├── Raw/                   # Census, Assets, (gitignored .pbf / .zip)
│   └── Processed/             # committed GeoJSON + CSV outputs
├── requirements.txt
└── .env.example
```

---

## Team workflow

Pull before starting work:

```bash
git pull origin main
```

Do not commit `.env`, the `venv/` folder, or large raw downloads (`.pbf`,
`.zip`) — `.gitignore` already covers them.
