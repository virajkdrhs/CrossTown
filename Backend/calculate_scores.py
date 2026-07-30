"""Turn the r5py travel-time matrix into a scored access grid.

Counts, per origin node, how many destinations of each category are reachable
inside the travel-time budget, then writes access_grid_final.geojson.
"""

from __future__ import annotations

import sys

from . import config


def main() -> int:
    print("--- Starting Access Score Calculation ---")

    import pandas as pd  # noqa: PLC0415
    import geopandas as gpd  # noqa: PLC0415

    for path in (
        config.TRAVEL_TIME_MATRIX_CSV,
        config.DESTINATIONS_CSV,
        config.ORIGINS_CSV,
    ):
        if not path.exists():
            print(f"ERROR: missing {path.relative_to(config.ROOT_DIR)}")
            if path == config.TRAVEL_TIME_MATRIX_CSV:
                print("       Run 'python -m Backend.routing_engine' first.")
            return 1

    print("[1/4] Loading matrix, destinations, and origin grid...")
    matrix_df = pd.read_csv(config.TRAVEL_TIME_MATRIX_CSV)
    dest_df = pd.read_csv(config.DESTINATIONS_CSV)
    grid_df = pd.read_csv(config.ORIGINS_CSV)

    # r5py has used both 'travel_time' and 'travel_time_p50' across versions.
    time_column = next(
        (name for name in ("travel_time", "travel_time_p50") if name in matrix_df.columns),
        None,
    )
    if time_column is None:
        print(f"ERROR: no travel-time column in matrix. Columns: {list(matrix_df.columns)}")
        return 1

    budget = config.TRAVEL_TIME_BUDGET_MIN
    print(f"[2/4] Filtering for destinations reachable within {budget} minutes...")
    reachable = matrix_df[matrix_df[time_column] <= budget].copy()
    reachable = reachable.merge(
        dest_df[["id", "category"]], left_on="to_id", right_on="id", how="inner"
    )

    print("[3/4] Aggregating category counts per grid point...")
    category_counts = (
        reachable.groupby(["from_id", "category"]).size().unstack(fill_value=0).reset_index()
    )

    # Derive the category list from the data so a new category (e.g. Recreation)
    # flows through without editing this file.
    categories = sorted(str(value) for value in dest_df["category"].dropna().unique())
    for category in categories:
        if category not in category_counts.columns:
            category_counts[category] = 0

    category_counts["access_score"] = category_counts[categories].sum(axis=1)

    # Left join so origins that reached nothing stay in the grid with zeros.
    final_grid = grid_df.merge(
        category_counts, left_on="id", right_on="from_id", how="left"
    )
    count_columns = [*categories, "access_score"]
    final_grid[count_columns] = final_grid[count_columns].fillna(0).astype(int)
    final_grid["from_id"] = final_grid["from_id"].fillna(final_grid["id"]).astype(int)

    print(f"[4/4] Writing {config.ACCESS_GRID_GEOJSON.relative_to(config.ROOT_DIR)}...")
    final_gdf = gpd.GeoDataFrame(
        final_grid,
        geometry=gpd.points_from_xy(final_grid.longitude, final_grid.latitude),
        crs="EPSG:4326",
    )
    config.PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    final_gdf.to_file(config.ACCESS_GRID_GEOJSON, driver="GeoJSON")

    reached_nothing = int((final_grid["access_score"] == 0).sum())
    print(
        f"--- Done. {len(final_grid)} nodes, mean raw score "
        f"{final_grid['access_score'].mean():.1f}, {reached_nothing} node(s) reached nothing ---"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
