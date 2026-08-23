/** Carpool planner: turn the gap report into concrete rides.
 *
 * Riders are staff with no vehicle whose transit commute fails. Drivers are
 * colleagues on the same shift already driving to the same site. Pickups happen
 * at grid zone points, never at home addresses.
 */

import { postJSON } from "./api.js";
import { map, setMarker, clearMarker, clearMarkersWithPrefix, fitToPoints, setVisibility, emptyCollection } from "./map.js";
import * as roster from "./roster.js";
import {
  escapeHTML, tile, money, toast, skeleton, emptyState, withBusy, toCSV, downloadCSV, plural,
} from "./ui.js";

const WORKSITE_PRESETS = [
  { label: "Short Pump retail corridor", lat: 37.65, lon: -77.61 },
  { label: "Innsbrook office park", lat: 37.658, lon: -77.57 },
  { label: "Downtown Richmond", lat: 37.5407, lon: -77.436 },
  { label: "Richmond International Airport", lat: 37.5052, lon: -77.3197 },
  { label: "White Oak Village", lat: 37.4936, lon: -77.3742 },
];

// Distinct hues so adjacent pool routes stay legible on a dark basemap.
const POOL_COLORS = [
  "#34d399", "#60a5fa", "#f472b6", "#fbbf24", "#a78bfa",
  "#22d3ee", "#fb923c", "#4ade80", "#f87171", "#c084fc",
];

let lastPlan = null;

export async function init() {
  const select = document.getElementById("carpool-worksite-preset");
  WORKSITE_PRESETS.forEach((preset, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = preset.label;
    select.appendChild(option);
  });
  select.addEventListener("change", () => {
    const preset = WORKSITE_PRESETS[Number(select.value)];
    if (preset) document.getElementById("carpool-worksite").value = preset.label;
  });
  select.value = "0";
  document.getElementById("carpool-worksite").value = WORKSITE_PRESETS[0].label;

  addLayers();

  document.getElementById("carpool-load-roster").addEventListener("click", loadRoster);
  document.getElementById("carpool-build").addEventListener("click", build);

  ["carpool-seats", "carpool-detour"].forEach((id) => {
    const input = document.getElementById(id);
    input.addEventListener("input", () => {
      document.getElementById(`${id}-value`).textContent = input.value;
    });
  });

  roster.onChange(reflectRoster);
  reflectRoster();

  document.getElementById("carpool-result").innerHTML = emptyState(
    "🚗",
    "No carpools yet",
    "Load the roster and pick a worksite. Riders who cannot reach it on transit get matched to colleagues already driving there."
  );

  window.addEventListener("crosstown:show-carpool", (event) => {
    const detail = event.detail || {};
    if (detail.worksite && detail.worksite.name) {
      const preset = WORKSITE_PRESETS.findIndex((item) => item.label === detail.worksite.name);
      if (preset >= 0) {
        document.getElementById("carpool-worksite-preset").value = String(preset);
        document.getElementById("carpool-worksite").value = detail.worksite.name;
      }
    }
  });
}

function reflectRoster() {
  const status = document.getElementById("carpool-roster-status");
  if (roster.isLoaded()) {
    status.innerHTML = `<span style="color:var(--ct-ok)">${roster.describe()}</span> · <span style="color:var(--ct-warn)">synthetic demo data</span>`;
    document.getElementById("carpool-build").disabled = false;
  } else {
    status.textContent = "No roster loaded.";
    document.getElementById("carpool-build").disabled = true;
  }
}

function addLayers() {
  map.addSource("carpool-routes-source", { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "carpool-routes-layer",
    type: "line",
    source: "carpool-routes-source",
    layout: { visibility: "none", "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 6, 3.5],
      "line-opacity": 0.85,
    },
  });

  map.addSource("carpool-pickups-source", { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "carpool-pickups-layer",
    type: "circle",
    source: "carpool-pickups-source",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": ["case", ["==", ["get", "role"], "driver"], 8, 6],
      "circle-color": ["get", "color"],
      "circle-stroke-width": ["case", ["==", ["get", "role"], "driver"], 3, 1.5],
      "circle-stroke-color": "#0f172a",
    },
  });

  map.addLayer({
    id: "carpool-pickups-order",
    type: "symbol",
    source: "carpool-pickups-source",
    layout: {
      visibility: "none",
      "text-field": ["get", "badge"],
      "text-size": 10,
      "text-allow-overlap": true,
    },
    paint: { "text-color": "#0f172a", "text-halo-color": "#f8fafc", "text-halo-width": 1 },
  });

  map.addSource("carpool-unmatched-source", { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "carpool-unmatched-layer",
    type: "circle",
    source: "carpool-unmatched-source",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": 7,
      "circle-color": "#7f1d1d",
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ef4444",
    },
  });

  map.on("click", "carpool-pickups-layer", (event) => {
    const props = event.features[0].properties;
    new maplibregl.Popup({ className: "ct-popup" })
      .setLngLat(event.features[0].geometry.coordinates)
      .setHTML(
        `<strong>${escapeHTML(props.employee_ref)}</strong><br>` +
          `<span class="ct-muted">${props.role === "driver" ? "Driver" : `Pickup ${props.badge}`} · zone ${
            props.origin_zone_id
          }</span>` +
          (props.pickup_time ? `<br><span class="ct-muted">${props.pickup_time}</span>` : "")
      )
      .addTo(map);
  });
  map.on("mouseenter", "carpool-pickups-layer", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "carpool-pickups-layer", () => {
    map.getCanvas().style.cursor = "";
  });
}

export const layers = [
  "carpool-routes-layer",
  "carpool-pickups-layer",
  "carpool-pickups-order",
  "carpool-unmatched-layer",
];

export function focus() {
  setVisibility(layers, true);
}

async function loadRoster() {
  const button = document.getElementById("carpool-load-roster");
  button.disabled = true;
  try {
    await roster.load();
  } catch (err) {
    document.getElementById("carpool-roster-status").innerHTML =
      `<span style="color:var(--ct-bad)">${escapeHTML(err.message)}</span>`;
    toast(err.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function build() {
  const button = document.getElementById("carpool-build");
  const errorEl = document.getElementById("carpool-error");
  errorEl.classList.add("hidden");

  if (!roster.isLoaded()) {
    errorEl.textContent = "Load a roster first.";
    errorEl.classList.remove("hidden");
    return;
  }

  const text = document.getElementById("carpool-worksite").value.trim();
  const preset = WORKSITE_PRESETS[Number(document.getElementById("carpool-worksite-preset").value)];
  const worksite =
    preset && text === preset.label
      ? { lat: preset.lat, lon: preset.lon, name: preset.label }
      : { address: text };

  const payload = {
    worksite,
    shift_start: "09:00",
    shift_end: "17:00",
    employees: roster.toPayload(true),
    seats_per_driver: Number(document.getElementById("carpool-seats").value),
    max_detour_minutes: Number(document.getElementById("carpool-detour").value),
  };

  const panel = document.getElementById("carpool-result");
  panel.innerHTML = skeleton(7, { heading: true });
  try {
    await withBusy(button, "Matching…", async () => {
      const data = await postJSON("/api/v2/carpool/plan", payload);
      lastPlan = data;
      render(data);
      draw(data);
      const summary = data.summary;
      toast(
        `${summary.riders_matched} of ${summary.riders_needing_ride} riders matched into ${plural(
          summary.pools_formed,
          "carpool"
        )}`,
        summary.riders_matched ? "ok" : "warn"
      );
    });
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
    panel.innerHTML = emptyState("⚠️", "Could not build carpools", err.message);
    toast(err.message, "error");
  }
}

function exportCSV() {
  if (!lastPlan) return;
  const rows = [];
  lastPlan.pools.forEach((pool) => {
    pool.riders.forEach((rider) => {
      rows.push({
        driver: pool.driver.employee_ref,
        driver_zone: pool.driver.origin_zone_id,
        depart: pool.depart_time,
        arrive: pool.arrive_time,
        detour: pool.detour_minutes,
        direct_km: pool.direct_km,
        route_km: pool.route_km,
        shift: pool.shift_start,
        rider: rider.employee_ref,
        rider_zone: rider.origin_zone_id,
        order: rider.order,
        pickup: rider.pickup_time,
      });
    });
  });
  lastPlan.unmatched.forEach((person) => {
    rows.push({
      driver: "", driver_zone: "", depart: "", arrive: "", detour: "", direct_km: "", route_km: "",
      shift: person.shift_start, rider: person.employee_ref,
      rider_zone: person.origin_zone_id, order: "", pickup: "UNMATCHED",
    });
  });
  const csv = toCSV(rows, [
    { label: "driver", get: (r) => r.driver },
    { label: "driver_zone", get: (r) => r.driver_zone },
    { label: "shift_start", get: (r) => r.shift },
    { label: "depart_time", get: (r) => r.depart },
    { label: "arrive_time", get: (r) => r.arrive },
    { label: "detour_minutes", get: (r) => r.detour },
    { label: "direct_km", get: (r) => r.direct_km },
    { label: "route_km", get: (r) => r.route_km },
    { label: "rider", get: (r) => r.rider },
    { label: "rider_zone", get: (r) => r.rider_zone },
    { label: "pickup_order", get: (r) => r.order },
    { label: "pickup_time", get: (r) => r.pickup },
  ]);
  const site = (lastPlan.worksite.name || "worksite").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  downloadCSV(`crosstown-carpool-plan-${site}-${lastPlan.day}.csv`, csv);
  toast("Carpool plan exported as CSV", "ok");
}

function render(data) {
  const summary = data.summary;
  const panel = document.getElementById("carpool-result");

  const headline = `
    <div class="rounded-xl border border-emerald-700/50 bg-emerald-950/30 p-3 mb-3 text-center">
      <p class="text-[10px] uppercase tracking-wider text-gray-400">Stranded staff given a ride</p>
      <p class="text-3xl font-extrabold text-emerald-400 my-0.5">${summary.riders_matched}
        <span class="text-lg text-gray-500">/ ${summary.riders_needing_ride}</span></p>
      <p class="text-[11px] text-gray-400">${summary.pct_matched}% matched into
        ${summary.pools_formed} carpool${summary.pools_formed === 1 ? "" : "s"}</p>
    </div>`;

  const tiles = [
    tile("Drivers used", `${summary.drivers_used}`, `of ${summary.drivers_available} available`),
    tile("Mean detour", `${summary.mean_detour_minutes} min`, "per driver"),
    tile("Total detour", `${summary.total_detour_minutes} min`, "across all drivers"),
    tile("Still stranded", `${summary.riders_unmatched}`, "no feasible driver"),
  ].join("");

  const routing = summary.routed_on_real_roads
    ? `<p class="text-[10px] mb-3 flex items-center gap-1.5" style="color:var(--ct-text-dim)">
         <span style="color:var(--ct-ok)">●</span> Routed on real roads — detours account for bridges and one-way streets.
       </p>`
    : `<p class="text-[10px] mb-3 flex items-center gap-1.5" style="color:var(--ct-warn)">
         <span>●</span> ${escapeHTML(summary.distance_note || "Straight-line estimate.")}
       </p>`;

  const pools = data.pools
    .map((pool, index) => {
      const color = POOL_COLORS[index % POOL_COLORS.length];
      const riders = pool.riders
        .map(
          (rider) =>
            `<li class="flex items-center gap-2">
               <span class="w-4 h-4 shrink-0 rounded-full text-[9px] font-bold flex items-center justify-center"
                     style="background:${color};color:#0f172a">${rider.order}</span>
               <span class="text-gray-300 flex-1 truncate">${escapeHTML(rider.employee_ref)}
                 <span class="text-gray-600">zone ${rider.origin_zone_id}</span></span>
               <span class="text-gray-500 text-[10px]">${rider.pickup_time}</span>
             </li>`
        )
        .join("");

      return `<div class="rounded-lg border border-gray-700/60 bg-gray-900/50 p-2.5 mb-2">
        <div class="flex items-center gap-2 mb-1.5">
          <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${color}"></span>
          <span class="text-xs font-bold text-gray-200 flex-1 truncate">${escapeHTML(
            pool.driver.employee_ref
          )} <span class="text-gray-500 font-normal">driving</span></span>
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-semibold shrink-0">+${
            pool.detour_minutes
          } min</span>
        </div>
        <p class="text-[10px] text-gray-500 mb-1.5">
          Leaves ${pool.depart_time} · arrives ${pool.arrive_time} · shift ${pool.shift_start}<br>
          Alone ${pool.direct_km ?? "?"} km / ${pool.direct_minutes} min →
          <span style="color:var(--ct-text-muted)">with pickups ${pool.route_km} km / ${pool.route_minutes} min</span>
        </p>
        <ul class="space-y-1 text-[11px]">${riders}</ul>
      </div>`;
    })
    .join("");

  const unmatched = data.unmatched.length
    ? `<details class="mb-2">
         <summary class="text-[11px] uppercase font-bold tracking-wider text-gray-500 cursor-pointer hover:text-gray-300">
           Still stranded (${data.unmatched.length})
         </summary>
         <div class="mt-2 space-y-1.5">
           ${data.unmatched
             .map(
               (person) =>
                 `<div class="text-[10px] border-l-2 border-red-700 pl-2">
                    <span class="text-gray-300">${escapeHTML(person.employee_ref)}</span>
                    <span class="text-gray-600">zone ${person.origin_zone_id}</span>
                    <p class="text-gray-500">${escapeHTML(person.reason)}</p>
                  </div>`
             )
             .join("")}
         </div>
       </details>`
    : "";

  panel.innerHTML = `
    ${headline}
    <div class="grid grid-cols-2 gap-2 mb-2">${tiles}</div>
    ${routing}
    <p class="text-[11px] uppercase font-bold tracking-wider mb-1.5" style="color:var(--ct-text-dim)">Proposed carpools</p>
    ${pools || '<p class="text-[11px] text-gray-500 mb-2">No carpools could be formed.</p>'}
    ${unmatched}
    <button id="carpool-export" class="w-full text-xs font-semibold py-2 rounded-lg transition mb-2"
            style="border:1px solid var(--ct-border);color:var(--ct-text-muted);background:var(--ct-raised)">
      Export carpool plan (CSV)
    </button>
    <p class="text-[10px] leading-relaxed mt-1 pt-2" style="color:var(--ct-text-dim);border-top:1px solid var(--ct-border-soft)">
      ${escapeHTML(data.note)}
    </p>`;

  document.getElementById("carpool-export").addEventListener("click", exportCSV);
}


function draw(data) {
  const routeFeatures = [];
  const pointFeatures = [];
  const points = [[data.worksite.lon, data.worksite.lat]];

  data.pools.forEach((pool, index) => {
    const color = POOL_COLORS[index % POOL_COLORS.length];
    // Prefer the real road polyline; fall back to straight lines between stops
    // when routing was unavailable.
    const line = pool.route_geometry && pool.route_geometry.length >= 2
      ? pool.route_geometry
      : pool.route;
    if (line && line.length >= 2) {
      routeFeatures.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: line },
        properties: { color, driver: pool.driver.employee_ref },
      });
      // Fit to the stops, not every vertex of the road geometry.
      (pool.route || []).forEach((point) => points.push(point));
    }
    pointFeatures.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [pool.driver.lon, pool.driver.lat] },
      properties: {
        color,
        role: "driver",
        badge: "D",
        employee_ref: pool.driver.employee_ref,
        origin_zone_id: pool.driver.origin_zone_id,
        pickup_time: pool.depart_time,
      },
    });
    pool.riders.forEach((rider) => {
      pointFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [rider.lon, rider.lat] },
        properties: {
          color,
          role: "rider",
          badge: String(rider.order),
          employee_ref: rider.employee_ref,
          origin_zone_id: rider.origin_zone_id,
          pickup_time: rider.pickup_time,
        },
      });
    });
  });

  map.getSource("carpool-routes-source").setData({
    type: "FeatureCollection",
    features: routeFeatures,
  });
  map.getSource("carpool-pickups-source").setData({
    type: "FeatureCollection",
    features: pointFeatures,
  });
  map.getSource("carpool-unmatched-source").setData({
    type: "FeatureCollection",
    features: data.unmatched
      .filter((person) => person.lon != null)
      .map((person) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [person.lon, person.lat] },
        properties: { employee_ref: person.employee_ref },
      })),
  });

  setMarker("carpool-worksite", [data.worksite.lon, data.worksite.lat], {
    color: "#f59e0b",
    label: `<strong>${escapeHTML(data.worksite.name)}</strong><br><span class="ct-muted">Worksite</span>`,
  });
  setVisibility(layers, true);
  fitToPoints(points, { padding: 70 });
}

export function clear() {
  clearMarker("carpool-worksite");
  clearMarkersWithPrefix("carpool-");
}

