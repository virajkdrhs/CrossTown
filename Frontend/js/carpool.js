/** Carpool planner: turn the gap report into concrete rides.
 *
 * Riders are staff with no vehicle whose transit commute fails. Drivers are
 * colleagues on the same shift already driving to the same site. Pickups happen
 * at grid zone points, never at home addresses.
 */

import { postJSON } from "./api.js";
import { map, THEME, setMarker, showMarkersWithPrefix, fitToPoints, setVisibility, emptyCollection } from "./map.js";
import * as roster from "./roster.js";
import {
  escapeHTML, tile, icon, sectionTitle, toast, skeleton, emptyState, withBusy, toCSV, downloadCSV, plural,
  syncRangeFill,
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
  "#5A78E0", "#34c759", "#ff2d55", "#ff9500", "#af52de",
  "#32ade6", "#ff6482", "#30b0c7", "#a2845e", "#5856d6",
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
  const input = document.getElementById("carpool-worksite");
  select.addEventListener("change", () => {
    const preset = WORKSITE_PRESETS[Number(select.value)];
    delete input.dataset.lat;
    delete input.dataset.lon;
    if (preset) input.value = preset.label;
    else {
      input.value = "";
      input.focus();
    }
  });
  input.addEventListener("input", () => {
    delete input.dataset.lat;
    delete input.dataset.lon;
    const match = WORKSITE_PRESETS.findIndex((preset) => preset.label === input.value.trim());
    select.value = String(match);
  });
  select.value = "0";
  document.getElementById("carpool-worksite").value = WORKSITE_PRESETS[0].label;

  addLayers();

  document.getElementById("carpool-load-roster").addEventListener("click", loadRoster);
  document.getElementById("carpool-build").addEventListener("click", build);

  [
    ["carpool-seats", (value) => value],
    ["carpool-detour", (value) => `${value} min`],
  ].forEach(([id, format]) => {
    const range = document.getElementById(id);
    const update = () => {
      document.getElementById(`${id}-value`).textContent = format(range.value);
      syncRangeFill(range);
    };
    range.addEventListener("input", update);
    update();
  });

  roster.onChange(reflectRoster);
  reflectRoster();

  document.getElementById("carpool-result").innerHTML = emptyState(
    "car",
    "No carpools yet",
    "Load the roster and pick a worksite. Riders who cannot reach it on transit get matched to colleagues already driving there."
  );

  window.addEventListener("crosstown:show-carpool", (event) => {
    const detail = event.detail || {};
    if (detail.worksite && detail.worksite.name) {
      const preset = WORKSITE_PRESETS.findIndex((item) => item.label === detail.worksite.name);
      select.value = String(preset);
      input.value = detail.worksite.name;
      if (preset < 0 && detail.worksite.lat != null) {
        input.dataset.lat = detail.worksite.lat;
        input.dataset.lon = detail.worksite.lon;
      }
    }
  });
}

function reflectRoster() {
  const status = document.getElementById("carpool-roster-status");
  if (roster.isLoaded()) {
    status.innerHTML =
      `<span style="color:var(--text)">${escapeHTML(roster.describe())}</span><br>` +
      `<span class="tiny text-3">Synthetic demo data</span>`;
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
      "line-width": 4.5,
      "line-opacity": 0.9,
    },
  });

  map.addSource("carpool-pickups-source", { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "carpool-pickups-layer",
    type: "circle",
    source: "carpool-pickups-source",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": ["case", ["==", ["get", "role"], "driver"], 10, 8],
      "circle-color": ["get", "color"],
      "circle-stroke-width": ["case", ["==", ["get", "role"], "driver"], 3, 2],
      "circle-stroke-color": THEME.stroke,
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
    paint: { "text-color": "#ffffff" },
  });

  map.addSource("carpool-unmatched-source", { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "carpool-unmatched-layer",
    type: "circle",
    source: "carpool-unmatched-source",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": 6,
      "circle-color": THEME.ink,
      "circle-stroke-width": 2.5,
      "circle-stroke-color": "#ff3b30",
    },
  });

  map.on("click", "carpool-pickups-layer", (event) => {
    const props = event.features[0].properties;
    new maplibregl.Popup({ className: "ct-popup" })
      .setLngLat(event.features[0].geometry.coordinates)
      .setHTML(
        `<strong>${escapeHTML(props.employee_ref)}</strong><br>` +
          `<span class="ct-muted">${props.role === "driver" ? "Driver" : `Pickup ${escapeHTML(props.badge)}`} · zone ${
            escapeHTML(props.origin_zone_id)
          }</span>` +
          (props.pickup_time ? `<br><span class="ct-muted">${escapeHTML(props.pickup_time)}</span>` : "")
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
  showMarkersWithPrefix("carpool-", true);
}

async function loadRoster() {
  const button = document.getElementById("carpool-load-roster");
  button.disabled = true;
  try {
    await roster.load();
  } catch (err) {
    document.getElementById("carpool-roster-status").innerHTML =
      `<span style="color:var(--red)">${escapeHTML(err.message)}</span>`;
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

  const input = document.getElementById("carpool-worksite");
  const text = input.value.trim();
  const preset = WORKSITE_PRESETS[Number(document.getElementById("carpool-worksite-preset").value)];
  let worksite;
  if (preset && text === preset.label) {
    worksite = { lat: preset.lat, lon: preset.lon, name: preset.label };
  } else if (input.dataset.lat && input.dataset.lon) {
    worksite = { lat: Number(input.dataset.lat), lon: Number(input.dataset.lon), name: text };
  } else if (text.length >= 3) {
    worksite = { address: text };
  } else {
    // An empty box used to reach the API and come back as a validation error.
    errorEl.textContent = "Choose or enter a worksite.";
    errorEl.classList.remove("hidden");
    return;
  }

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
    panel.innerHTML = emptyState("triangle", "Couldn't build carpools", err.message);
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
    <div class="hero">
      <p class="hero-label">Stranded staff given a ride</p>
      <p class="hero-number" style="color:var(--green)">${summary.riders_matched}<span class="of"> / ${summary.riders_needing_ride}</span></p>
      <p class="hero-sub">${summary.pct_matched}% matched into ${plural(summary.pools_formed, "carpool")}</p>
    </div>`;

  const tiles = [
    tile("Drivers", `${summary.drivers_used}`, `of ${summary.drivers_available} available`),
    tile("Average detour", `${summary.mean_detour_minutes} min`, "per driver"),
    tile("Total detour", `${summary.total_detour_minutes} min`, "across all drivers"),
    tile("Still stranded", `${summary.riders_unmatched}`, "no feasible driver", summary.riders_unmatched ? "var(--red)" : ""),
  ].join("");

  const routing = summary.routed_on_real_roads
    ? `<p class="group-note hstack gap-2" style="color:var(--green)">${icon("check", 14, 2.5)}Routed on real roads, so detours account for bridges and one-way streets.</p>`
    : `<p class="group-note hstack gap-2" style="color:var(--orange)">${icon("alert-circle", 14)}${escapeHTML(
        summary.distance_note || "Straight-line estimate."
      )}</p>`;

  const pools = data.pools
    .map((pool, index) => {
      const color = POOL_COLORS[index % POOL_COLORS.length];
      const riders = pool.riders
        .map(
          (rider) =>
            `<li>
               <span class="order-dot" style="background:${color}">${escapeHTML(rider.order)}</span>
               <span class="grow truncate">${escapeHTML(rider.employee_ref)} <span class="text-3">· zone ${escapeHTML(
                 rider.origin_zone_id
               )}</span></span>
               <span class="text-2 small num">${escapeHTML(rider.pickup_time)}</span>
             </li>`
        )
        .join("");

      return `<div class="pool">
        <div class="pool-head">
          <span class="pool-swatch" style="background:${color}"></span>
          <span class="grow truncate strong">${escapeHTML(pool.driver.employee_ref)} <span class="text-3" style="font-weight:400">driving</span></span>
          <span class="pool-detour">+${escapeHTML(pool.detour_minutes)} min</span>
        </div>
        <p class="pool-meta">
          Leaves ${escapeHTML(pool.depart_time)} · arrives ${escapeHTML(pool.arrive_time)} · shift ${escapeHTML(pool.shift_start)}<br>
          ${escapeHTML(pool.direct_km ?? "?")} km alone → ${escapeHTML(pool.route_km)} km with pickups
        </p>
        <ul class="pool-riders">${riders}</ul>
      </div>`;
    })
    .join("");

  const unmatched = data.unmatched.length
    ? `<details class="group">
         <summary>Still stranded <span class="text-3 grow right" style="margin-right:10px">${data.unmatched.length}</span></summary>
         ${data.unmatched
           .map(
             (person) =>
               `<div class="row" style="align-items:flex-start;flex-direction:column;gap:2px">
                  <span>${escapeHTML(person.employee_ref)} <span class="text-3">· zone ${escapeHTML(person.origin_zone_id)}</span></span>
                  <span class="small text-2">${escapeHTML(person.reason)}</span>
                </div>`
           )
           .join("")}
       </details>`
    : "";

  panel.innerHTML = `
    ${headline}
    <div>
      <div class="tile-grid">${tiles}</div>
      ${routing}
    </div>
    <div>
      ${sectionTitle("Proposed carpools", plural(data.pools.length, "car"))}
      ${pools ? `<div class="group">${pools}</div>` : '<div class="group row small text-2">No carpools could be formed.</div>'}
    </div>
    ${unmatched}
    <button id="carpool-export" class="btn btn-secondary btn-block">${icon("download", 16)}Export carpool plan (CSV)</button>
    <p class="fineprint">${escapeHTML(data.note)}</p>`;

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
    color: "#ff9500",
    label: `<strong>${escapeHTML(data.worksite.name)}</strong><br><span class="ct-muted">Worksite</span>`,
  });
  setVisibility(layers, true);
  fitToPoints(points, { padding: 70 });
}

export function clear() {
  showMarkersWithPrefix("carpool-", false);
}

