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

/** Resolves when it is safe to call addSource/addLayer.
 *
 * Deliberately NOT `map.on("load")`. That event waits for the basemap's vector
 * tiles as well as its stylesheet, so a slow, rate-limited or blocked tile CDN
 * left every view uninitialised — with no console error, because the promise
 * simply never settled. Adding sources and layers only requires the style to be
 * parsed, which is what `style.load` signals. The county data then renders over
 * whatever the basemap manages to fetch.
 */
export const ready = new Promise((resolve, reject) => {
  if (map.style && map.style._loaded) {
    resolve();
    return;
  }
  map.once("style.load", () => resolve());
  setTimeout(
    () =>
      reject(
        new Error(
          "The basemap style did not load. Check your network connection to " +
            "basemaps.cartocdn.com, then reload."
        )
      ),
    20000
  );
});

// ES module scope is not reachable from the console, which makes a misbehaving
// layer painful to inspect. Expose the map for local debugging only.
if (["localhost", "127.0.0.1"].includes(window.location.hostname)) {
  window.__crosstown = { map, ready };
}

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
  map.fitBounds(bounds, {
    padding: options.padding ?? 70,
    duration: options.duration ?? 600,
    // Without a cap a 900 m trip zooms to individual buildings, which loses all
    // sense of where in the county you are.
    maxZoom: options.maxZoom ?? 14.5,
  });
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
