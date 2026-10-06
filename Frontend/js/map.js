/** Shared MapLibre instance and helpers used by every view. */

export const HENRICO_CENTER = [-77.48, 37.58];

/** Chosen once at load: the basemap cannot be swapped without losing layers. */
export const dark =
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;

/** Colours that must contrast with the basemap rather than with the panel. */
export const THEME = dark
  ? { stroke: "#1c1c1e", halo: "#000000", label: "#f5f5f7", ink: "#1c1c1e" }
  : { stroke: "#ffffff", halo: "#ffffff", label: "#1d1d1f", ink: "#ffffff" };

export const map = new maplibregl.Map({
  container: "map",
  style: dark
    ? "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
    : "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  center: HENRICO_CENTER,
  zoom: 10.5,
  attributionControl: false,
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-right");

// MapLibre can measure the container before the layout settles, leaving the
// canvas a fraction of the viewport. Watching the container keeps them in sync.
if (typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => {
    map.resize();
    syncPadding(false);
  }).observe(document.getElementById("map"));
} else {
  window.addEventListener("resize", () => map.resize());
}

/** Resolves when it is safe to call addSource/addLayer.
 *
 * Deliberately NOT `map.on("load")`. That event waits for the basemap's vector
 * tiles as well as its stylesheet, so a slow, rate-limited or blocked tile CDN
 * left every view uninitialised — with no console error, because the promise
 * simply never settled. Adding sources and layers only requires the style to be
 * parsed, which is what `style.load` signals.
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

/* ------------------------------------------------------------------ padding */

/** The panel floats over the map, so camera moves must frame the visible part.
 *
 * Setting the map's own padding shifts the centre for every fitBounds/easeTo,
 * which keeps each view's fitting code ignorant of the panel.
 */
export function syncPadding(animate = true) {
  const panel = document.getElementById("sidebar");
  const container = map.getContainer();
  const padding = { top: 0, right: 0, bottom: 0, left: 0 };
  if (panel && !panel.classList.contains("ct-collapsed")) {
    const panelBox = panel.getBoundingClientRect();
    const mapBox = container.getBoundingClientRect();
    const narrow = panelBox.width > mapBox.width * 0.8;
    if (narrow) padding.bottom = Math.max(0, mapBox.bottom - panelBox.top);
    else padding.left = Math.max(0, panelBox.right - mapBox.left);
  }
  if (animate) map.easeTo({ padding, duration: 450 });
  else map.setPadding(padding);
}

/* ------------------------------------------------------------------- helpers */

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
  // The legend cards float in the bottom-right corner; keep fitted points
  // clear of them as well as of the panel (handled by the map's own padding).
  const base = options.padding ?? 60;
  const legend = document.getElementById("legend-host");
  const legendWidth =
    legend && legend.offsetParent !== null ? legend.offsetWidth + 14 : 0;
  map.fitBounds(bounds, {
    padding: { top: base, bottom: base, left: base, right: base + legendWidth },
    duration: options.duration ?? 700,
    // Without a cap a 900 m trip zooms to individual buildings, which loses all
    // sense of where in the county you are.
    maxZoom: options.maxZoom ?? 14.5,
  });
}

/* ------------------------------------------------------------------- markers */

const markers = new Map();

/** Add or move a named marker, so views do not leak marker instances. */
export function setMarker(key, lonLat, options = {}) {
  clearMarker(key);
  if (!lonLat) return null;
  const marker = new maplibregl.Marker({ color: options.color ?? "#0071e3" }).setLngLat(lonLat);
  if (options.label) {
    marker.setPopup(new maplibregl.Popup({ className: "ct-popup", offset: 30 }).setHTML(options.label));
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

/** Hide or reveal a view's markers without discarding them.
 *
 * Views used to delete their markers on the way out, yet re-show their route
 * layers on the way back in — so returning to a view showed a route line with
 * no home or workplace pin at either end.
 */
export function showMarkersWithPrefix(prefix, visible) {
  markers.forEach((marker, key) => {
    if (!key.startsWith(prefix)) return;
    if (!visible && marker.getPopup()?.isOpen()) marker.togglePopup();
    marker.getElement().style.display = visible ? "" : "none";
  });
}
