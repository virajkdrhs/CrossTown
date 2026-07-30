/** Shared MapLibre instance and helpers used by every view. */

export const HENRICO_CENTER = [-77.48, 37.58];

export const map = new maplibregl.Map({
  container: "map",
  style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  center: HENRICO_CENTER,
  zoom: 10.5,
});

map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-right");

// Tailwind's CDN build injects its stylesheet asynchronously, so MapLibre often
// measures the container before the flex layout has settled and the canvas ends
// up a fraction of the viewport. Watching the container keeps them in sync,
// including when the sidebar is toggled.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => map.resize()).observe(document.getElementById("map"));
} else {
  window.addEventListener("resize", () => map.resize());
}

export const ready = new Promise((resolve) => {
  if (map.loaded()) resolve();
  else map.once("load", resolve);
});

/** Replace a GeoJSON source's data, creating the source and layers on first use. */
export function setGeoJSON(sourceId, data, layerFactory) {
  const existing = map.getSource(sourceId);
  if (existing) {
    existing.setData(data);
    return false;
  }
  map.addSource(sourceId, { type: "geojson", data });
  if (layerFactory) layerFactory();
  return true;
}

export function setVisibility(layerIds, visible) {
  layerIds.forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  });
}

export function emptyCollection() {
  return { type: "FeatureCollection", features: [] };
}

/** Fit the map to a set of [lon, lat] points. */
export function fitToPoints(points, options = {}) {
  const usable = points.filter((point) => Array.isArray(point) && point.length >= 2);
  if (!usable.length) return;
  if (usable.length === 1) {
    map.easeTo({ center: usable[0], zoom: options.singleZoom ?? 13 });
    return;
  }
  const bounds = new maplibregl.LngLatBounds();
  usable.forEach((point) => bounds.extend(point));
  map.fitBounds(bounds, { padding: options.padding ?? 70, duration: options.duration ?? 600 });
}

const markers = new Map();

/** Add or move a named marker, so views do not leak marker instances. */
export function setMarker(key, lonLat, options = {}) {
  clearMarker(key);
  if (!lonLat) return null;
  const marker = new maplibregl.Marker({ color: options.color ?? "#10b981" }).setLngLat(lonLat);
  if (options.label) {
    marker.setPopup(new maplibregl.Popup({ className: "ct-popup", offset: 18 }).setHTML(options.label));
  }
  marker.addTo(map);
  markers.set(key, marker);
  return marker;
}

export function clearMarker(key) {
  const existing = markers.get(key);
  if (existing) {
    existing.remove();
    markers.delete(key);
  }
}

export function clearMarkersWithPrefix(prefix) {
  [...markers.keys()]
    .filter((key) => key.startsWith(prefix))
    .forEach((key) => clearMarker(key));
}
