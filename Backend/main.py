from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import geopandas as gpd
from sqlalchemy import create_engine, text
from geopy.geocoders import Nominatim
import json

app = FastAPI(title="CrossTown API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_USER = "postgres"
DB_PASS = "YOUR_ACTUAL_PASSWORD_HERE"  # Update with your password!
DB_HOST = "localhost"
DB_PORT = "5432"
DB_NAME = "crosstown"

DATABASE_URL = f"postgresql://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
engine = create_engine(DATABASE_URL)

geolocator = Nominatim(user_agent="crosstown_prototype")

class AddressQuery(BaseModel):
    address: str

def scale_to_100(val, max_expected=15):
    """Normalize raw amenity counts or raw scores to a 0-100 scale."""
    if val is None or val < 0:
        return 0
    return min(100, int((float(val) / max_expected) * 100))

def normalize_scores(raw_overall, food, health, education, civic):
    """Fills blank/missing scores using overall node weight and normalizes to 100."""
    overall_100 = scale_to_100(raw_overall, max_expected=20)
    
    # Baseline fallback estimating category sub-scores if data column is null/zero
    base_estimate = max(5, int(overall_100 * 0.75))
    
    f_score = scale_to_100(food, 5) if food and food > 0 else base_estimate
    h_score = scale_to_100(health, 3) if health and health > 0 else base_estimate
    e_score = scale_to_100(education, 4) if education and education > 0 else base_estimate
    c_score = scale_to_100(civic, 4) if civic and civic > 0 else base_estimate
    
    return {
        "overall_score": overall_100,
        "food": f_score,
        "health": h_score,
        "education": e_score,
        "civic": c_score
    }

@app.get("/")
def read_root():
    return {"status": "online", "message": "CrossTown Spatial API is running"}

@app.get("/api/v1/grid")
def get_access_grid():
    """Fetch grid and inject 0-100 scaled scores directly into GeoJSON properties."""
    try:
        query = "SELECT * FROM access_grid;"
        gdf = gpd.read_postgis(query, con=engine, geom_col="geometry")
        
        # Calculate scaled scores row by row
        scaled_scores = []
        for _, row in gdf.iterrows():
            scores = normalize_scores(
                row.get('access_score', 0),
                row.get('Food', 0),
                row.get('Health', 0),
                row.get('Education', 0),
                row.get('Civic', 0)
            )
            scaled_scores.append(scores['overall_score'])
        
        gdf['access_score_100'] = scaled_scores
        return json.loads(gdf.to_json())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Grid fetch error: {str(e)}")

@app.get("/api/v1/demographics")
def get_demographics():
    try:
        query = "SELECT * FROM census_carfree;"
        gdf = gpd.read_postgis(query, con=engine, geom_col="geometry")
        return json.loads(gdf.to_json())
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Demographics fetch error: {str(e)}")

@app.post("/api/v1/reachability")
def query_reachability(payload: AddressQuery):
    try:
        full_address = f"{payload.address}, Henrico County, VA"
        location = geolocator.geocode(full_address)
        
        if not location:
            raise HTTPException(status_code=404, detail="Address not found within Henrico County.")
            
        lon, lat = location.longitude, location.latitude

        sql_query = text("""
            SELECT id, "Food", "Health", "Education", "Civic", access_score,
                   ST_X(geometry) as lon, ST_Y(geometry) as lat,
                   ST_Distance(geometry::geography, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography) as dist_meters
            FROM access_grid
            ORDER BY geometry <-> ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)
            LIMIT 1;
        """)

        with engine.connect() as conn:
            result = conn.execute(sql_query, {"lon": lon, "lat": lat}).fetchone()

        if not result:
            raise HTTPException(status_code=404, detail="No matching grid node found.")

        scores_100 = normalize_scores(
            result.access_score, result.Food, result.Health, result.Education, result.Civic
        )

        return {
            "query_address": location.address,
            "coordinates": {"latitude": lat, "longitude": lon},
            "nearest_node": {
                "id": result.id,
                "node_latitude": result.lat,
                "node_longitude": result.lon,
                "distance_meters": round(result.dist_meters, 1)
            },
            "scores": scores_100
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Spatial lookup error: {str(e)}")