/** GRTC LINK on-demand microtransit zones — a shared map layer.
 *
 * These zones are the difference between telling somebody in Varina "no service"
 * and telling them GRTC will collect them from home for free. They are absent
 * from the GTFS feed, so they are drawn from Data/Raw/Transit/link_zones.geojson.
 */

import { getJSON } from "./api.js";
import { map, setVisibility, emptyCollection } from "./map.js";
import { escapeHTML } from "./ui.js";

export const layers = ["link-zones-fill", "link-zones-outline", "link-zones-label"];

let loaded = false;
let metadata = {};

export async function init() {
  map.addSource("link-zones-source", { type: "geojson", data: emptyCollection() });

  map.addLayer({
    id: "link-zones-fill",
    type: "fill",
    source: "link-zones-source",
    layout: { visibility: "none" },
    paint: {
      "fill-color": ["case", ["get", "runs_today"], "#38bdf8", "#64748b"],
      "fill-opacity": 0.13,
    },
  });
  map.addLayer({
    id: "link-zones-outline",
    type: "line",
    source: "link-zones-source",
    layout: { visibility: "none" },
    paint: {
      "line-color": ["case", ["get", "runs_today"], "#38bdf8", "#64748b"],
      "line-width": 1.5,
      "line-dasharray": [3, 2],
      "line-opacity": 0.75,
    },
  });
  map.addLayer({
    id: "link-zones-label",
    type: "symbol",
    source: "link-zones-source",
    layout: {
      visibility: "none",
      "text-field": ["concat", "LINK ", ["get", "name"]],
      "text-size": 11,
      "text-transform": "uppercase",
      "text-letter-spacing": 0.08,
    },
    paint: {
      "text-color": "#7dd3fc",
      "text-halo-color": "#0b1120",
      "text-halo-width": 1.5,
    },
  });

  map.on("click", "link-zones-fill", (event) => {
    const props = event.features[0].properties;
    let hours;
    try {
      hours = JSON.parse(props.hours_today || "null");
    } catch (_) {
      hours = null;
    }
    let routes = [];
    try {
      routes = JSON.parse(props.connects_routes || "[]");
    } catch (_) {
      routes = [];
    }
    new maplibregl.Popup({ className: "ct-popup", maxWidth: "280px" })
      .setLngLat(event.lngLat)
      .setHTML(
        `<strong>LINK ${escapeHTML(props.name)}</strong><br>` +
          `<span class="ct-muted">${escapeHTML(props.locality)}</span><br>` +
          `<span class="ct-muted">${
            hours ? `Today ${escapeHTML(hours[0])}–${escapeHTML(hours[1])}` : "Not running today"
          } · wait ~${escapeHTML(props.wait_minutes)} min · free</span>` +
          (routes.length
            ? `<br><span class="ct-muted">Connects: ${routes.slice(0, 6).map(escapeHTML).join(", ")}</span>`
            : "") +
          `<br><span class="ct-muted" style="font-size:10px">Book in GRTC On the Go · boundary approximate</span>`
      )
      .addTo(map);
  });
  map.on("mouseenter", "link-zones-fill", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "link-zones-fill", () => {
    map.getCanvas().style.cursor = "";
  });

  try {
    const data = await getJSON("/api/v2/microtransit/zones");
    metadata = data.metadata || {};
    map.getSource("link-zones-source").setData(data);
    loaded = true;
  } catch (err) {
    console.warn("LINK zones unavailable:", err);
  }
}

export function show(visible) {
  if (loaded) setVisibility(layers, visible);
}

export function isLoaded() {
  return loaded;
}

export function boundaryNote() {
  return metadata.boundaries || "Zone boundaries are approximate.";
}
