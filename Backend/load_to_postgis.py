import os
import geopandas as gpd
from sqlalchemy import create_engine

def main():
    print("--- Starting PostGIS Data Ingestion ---")

    # DATABASE CREDENTIALS
    # Replace 'YOUR_ACTUAL_PASSWORD_HERE' with the password you created during PostgreSQL installation
    DB_USER = "postgres"
    DB_PASS = "101110"  
    DB_HOST = "localhost"
    DB_PORT = "5432"
    DB_NAME = "crosstown"

    # Create connection engine
    connection_url = f"postgresql://{DB_USER}:{DB_PASS}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
    engine = create_engine(connection_url)

    # File Paths
    PROCESSED_DIR = os.path.abspath("data/processed")
    access_grid_path = os.path.join(PROCESSED_DIR, "access_grid_final.geojson")
    census_path = os.path.join(PROCESSED_DIR, "census_carfree.geojson")

    # 1. Ingest Scored Access Grid
    if os.path.exists(access_grid_path):
        print("[1/2] Ingesting access_grid_final.geojson into PostGIS...")
        grid_gdf = gpd.read_file(access_grid_path)
        
        # Save to PostGIS table named 'access_grid'
        grid_gdf.to_postgis(
            name="access_grid",
            con=engine,
            if_exists="replace",
            index=False
        )
        print(" -> Table 'access_grid' successfully created!")
    else:
        print(f" ERROR: Missing file {access_grid_path}")

    # 2. Ingest Census Car-Free Layer
    if os.path.exists(census_path):
        print("[2/2] Ingesting census_carfree.geojson into PostGIS...")
        census_gdf = gpd.read_file(census_path)
        
        # Save to PostGIS table named 'census_carfree'
        census_gdf.to_postgis(
            name="census_carfree",
            con=engine,
            if_exists="replace",
            index=False
        )
        print(" -> Table 'census_carfree' successfully created!")
    else:
        print(f" WARNING: Missing file {census_path}. Skipping census table creation.")

    print("--- PostGIS Ingestion Complete! ---")

if __name__ == "__main__":
    main()