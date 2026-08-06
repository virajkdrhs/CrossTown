/** Employer dashboard: which staff cannot reach this worksite on transit.
 *
 * Employees are located by access-grid zone, never by street address - the same
 * rule the live product would follow, so a demo screenshot can never leak a home
 * location.
 */

import { postJSON } from "./api.js";
import { map, setMarker, clearMarker, fitToPoints, setVisibility, emptyCollection } from "./map.js";
import * as roster from "./roster.js";

const WORKSITE_PRESETS = [
  { label: "Innsbrook office park", lat: 37.658, lon: -77.57 },
  { label: "Short Pump retail corridor", lat: 37.65, lon: -77.61 },
  { label: "Downtown Richmond", lat: 37.5407, lon: -77.436 },
  { label: "Richmond International Airport", lat: 37.5052, lon: -77.3197 },
  { label: "White Oak Village", lat: 37.4936, lon: -77.3742 },
];

const VERDICT_COLORS = {
  viable: "#10b981",
  marginal: "#f59e0b",
  gap: "#ef4444",
  no_service: "#b91c1c",
};

const REASON_LABELS = {
  no_stop_near_destination: "No bus stop near the worksite",
  no_stop_near_origin: "No bus stop near home",
  no_service_at_hour: "No service at that hour",
  no_return: "No way home after the shift",
  too_long: "Over 60 minutes each way",
  return_too_long: "Trip home over 60 minutes",
  long: "45–60 minutes each way",
  many_transfers: "3 or more transfers",
  transfers: "2 transfers",
  early_departure: "Would have to leave before 05:00",
};

export async function init() {
  const select = document.getElementById("employer-worksite-preset");
  WORKSITE_PRESETS.forEach((preset, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = preset.label;
    select.appendChild(option);
  });
  select.addEventListener("change", () => {
    const preset = WORKSITE_PRESETS[Number(select.value)];
    if (preset) {
      const input = document.getElementById("employer-worksite");
      input.value = preset.label;
      delete input.dataset.lat;
      delete input.dataset.lon;
    }
  });
  // Start on a real preset so the text box and the dropdown agree. Otherwise the
  // default state geocodes a preset *label*, which Nominatim cannot resolve.
  select.value = "0";
  document.getElementById("employer-worksite").value = WORKSITE_PRESETS[0].label;

  addLayers();

  document.getElementById("employer-load-roster").addEventListener("click", loadRoster);
  document.getElementById("employer-analyse").addEventListener("click", analyse);

  roster.onChange(reflectRoster);
  reflectRoster();

  window.addEventListener("crosstown:show-employer", (event) => {
    const detail = event.detail || {};
    if (detail.worksite) {
      document.getElementById("employer-worksite").value = detail.worksite.name || "";
      document.getElementById("employer-worksite").dataset.lat = detail.worksite.lat;
      document.getElementById("employer-worksite").dataset.lon = detail.worksite.lon;
    }
    if (detail.shift_start) document.getElementById("employer-shift-start").value = detail.shift_start;
    if (detail.shift_end) document.getElementById("employer-shift-end").value = detail.shift_end;
  });
}

function addLayers() {
  map.addSource("employer-employees-source", { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "employer-employees-layer",
    type: "circle",
    source: "employer-employees-source",
    layout: { visibility: "none" },
    paint: {
      // Radius grows with how many staff share the zone.
      "circle-radius": [
        "interpolate", ["linear"], ["get", "employee_count"],
        1, 7,
        4, 13,
        8, 20,
      ],
      "circle-color": [
        "match", ["get", "worst_verdict"],
        "viable", VERDICT_COLORS.viable,
        "marginal", VERDICT_COLORS.marginal,
        "gap", VERDICT_COLORS.gap,
        "no_service", VERDICT_COLORS.no_service,
        "#64748b",
      ],
      "circle-opacity": 0.75,
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#0f172a",
    },
  });

  map.addLayer({
    id: "employer-employees-count",
    type: "symbol",
    source: "employer-employees-source",
    layout: {
      visibility: "none",
      "text-field": ["to-string", ["get", "employee_count"]],
      "text-size": 11,
      "text-allow-overlap": true,
    },
    paint: { "text-color": "#0f172a", "text-halo-color": "#f8fafc", "text-halo-width": 1 },
  });

  map.addSource("employer-carpool-source", { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "employer-carpool-layer",
    type: "circle",
    source: "employer-carpool-source",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": [
        "interpolate", ["linear"], ["get", "employee_count"],
        2, 16,
        8, 30,
      ],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-width": 2.5,
      "circle-stroke-color": "#34d399",
      "circle-stroke-opacity": 0.9,
    },
  });

  map.on("click", "employer-employees-layer", (event) => {
    const props = event.features[0].properties;
    const refs = JSON.parse(props.employees || "[]");
    new maplibregl.Popup({ className: "ct-popup", maxWidth: "260px" })
      .setLngLat(event.features[0].geometry.coordinates)
      .setHTML(
        `<strong>Zone ${props.origin_zone_id}</strong><br>` +
          `<span class="ct-muted">${props.employee_count} employee(s)</span><br>` +
          `<span class="ct-muted">Worst outcome: ${props.worst_verdict.replace("_", " ")}</span><br>` +
          `<span class="ct-muted" style="font-size:10px">${refs.join(", ")}</span>`
      )
      .addTo(map);
  });
  map.on("mouseenter", "employer-employees-layer", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "employer-employees-layer", () => {
    map.getCanvas().style.cursor = "";
  });
}

export const layers = [
  "employer-employees-layer",
  "employer-employees-count",
  "employer-carpool-layer",
];

export function focus() {
  setVisibility(layers, true);
}

async function loadRoster() {
  const button = document.getElementById("employer-load-roster");
  button.disabled = true;
  try {
    await roster.load();
  } catch (err) {
    document.getElementById("employer-roster-status").innerHTML =
      `<span class="text-red-400">${escapeHTML(err.message)}</span>`;
  } finally {
    button.disabled = false;
  }
}

function reflectRoster() {
  const status = document.getElementById("employer-roster-status");
  if (roster.isLoaded()) {
    status.innerHTML =
      `<span class="text-emerald-400">${roster.describe()}</span> · ` +
      `<span class="text-amber-400/90">synthetic demo data</span>`;
    document.getElementById("employer-analyse").disabled = false;
  } else {
    status.textContent = "No roster loaded.";
    document.getElementById("employer-analyse").disabled = true;
  }
}

async function analyse() {
  const button = document.getElementById("employer-analyse");
  const errorEl = document.getElementById("employer-error");
  errorEl.classList.add("hidden");

  if (!roster.isLoaded()) {
    errorEl.textContent = "Load a roster first.";
    errorEl.classList.remove("hidden");
    return;
  }

  const input = document.getElementById("employer-worksite");
  const text = input.value.trim();
  const presetIndex = Number(document.getElementById("employer-worksite-preset").value);
  const preset = WORKSITE_PRESETS[presetIndex];

  let worksite;
  if (preset && text === preset.label) {
    worksite = { lat: preset.lat, lon: preset.lon, name: preset.label };
  } else if (input.dataset.lat && input.dataset.lon) {
    worksite = { lat: Number(input.dataset.lat), lon: Number(input.dataset.lon), name: text };
  } else if (text.length >= 3) {
    worksite = { address: text };
  } else {
    errorEl.textContent = "Choose or enter a worksite.";
    errorEl.classList.remove("hidden");
    return;
  }

  const useOwnShifts = document.getElementById("employer-use-own-shifts").checked;
  const payload = {
    worksite,
    shift_start: document.getElementById("employer-shift-start").value || "09:00",
    shift_end: document.getElementById("employer-shift-end").value || null,
    employees: roster.toPayload(useOwnShifts),
  };

  button.disabled = true;
  button.textContent = "Analysing…";
  try {
    const data = await postJSON("/api/v2/roster/gaps", payload);
    render(data);
    draw(data);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
  } finally {
    button.disabled = false;
    button.textContent = "Analyse roster";
  }
}

function render(data) {
  const summary = data.summary;
  const panel = document.getElementById("employer-result");

  const headline = `
    <div class="rounded-xl border border-red-700/50 bg-red-950/30 p-3 mb-3 text-center">
      <p class="text-[10px] uppercase tracking-wider text-gray-400">Staff who cannot reach this site on transit</p>
      <p class="text-3xl font-extrabold text-red-400 my-0.5">${summary.in_gap}
        <span class="text-lg text-gray-500">/ ${summary.employees_analysed}</span></p>
      <p class="text-[11px] text-gray-400">${summary.pct_in_gap}% of the roster ·
        <span class="text-amber-400">${summary.in_gap_without_vehicle} of them own no car</span></p>
    </div>`;

  const verdictBar = ["viable", "marginal", "gap", "no_service"]
    .map((key) => {
      const count = summary.verdicts[key] || 0;
      if (!count) return "";
      const width = (100 * count) / summary.employees_analysed;
      return `<div style="width:${width}%;background:${VERDICT_COLORS[key]}" title="${key}: ${count}"></div>`;
    })
    .join("");

  const legend = ["viable", "marginal", "gap", "no_service"]
    .filter((key) => summary.verdicts[key])
    .map(
      (key) =>
        `<span class="inline-flex items-center gap-1"><span class="w-2 h-2 rounded-full" style="background:${
          VERDICT_COLORS[key]
        }"></span>${key.replace("_", " ")} ${summary.verdicts[key]}</span>`
    )
    .join('<span class="text-gray-700 mx-1">·</span>');

  const reasons = Object.entries(summary.top_reasons || {})
    .map(
      ([code, count]) =>
        `<div class="flex justify-between gap-3"><span>${escapeHTML(
          REASON_LABELS[code] || code
        )}</span><span class="text-gray-200 font-semibold">${count}</span></div>`
    )
    .join("");

  const carpools = (data.carpool_candidates || [])
    .map(
      (candidate) =>
        `<div class="flex justify-between items-center gap-2 py-1 border-b border-gray-700/40 last:border-0">
           <span>Zone ${candidate.origin_zone_id}</span>
           <span class="text-emerald-400 font-semibold">${candidate.employee_count} riders</span>
         </div>`
    )
    .join("");

  const totalPooled = (data.carpool_candidates || []).reduce(
    (sum, candidate) => sum + candidate.employee_count,
    0
  );

  const rows = data.employees
    .slice()
    .sort((a, b) => rank(a.verdict) - rank(b.verdict))
    .map(
      (employee) => `
      <tr class="border-b border-gray-700/40">
        <td class="py-1 pr-2 text-gray-300 whitespace-nowrap">${escapeHTML(employee.employee_ref)}</td>
        <td class="py-1 pr-2 text-gray-500">${employee.origin_zone_id ?? "—"}</td>
        <td class="py-1 pr-2 text-gray-500 whitespace-nowrap">${escapeHTML(
          employee.shift_start || "—"
        )}</td>
        <td class="py-1 pr-2"><span class="px-1.5 py-0.5 rounded text-[9px] font-bold" style="background:${
          VERDICT_COLORS[employee.verdict]
        }22;color:${VERDICT_COLORS[employee.verdict]}">${employee.verdict.replace("_", " ")}</span></td>
        <td class="py-1 text-right text-gray-400 whitespace-nowrap">${
          employee.transit_minutes != null ? `${employee.transit_minutes}m` : "—"
        }</td>
      </tr>`
    )
    .join("");

  panel.innerHTML = `
    ${headline}
    <div class="mb-1 h-2 rounded-full overflow-hidden flex bg-gray-900">${verdictBar}</div>
    <p class="text-[10px] text-gray-400 mb-3 flex flex-wrap gap-x-1 gap-y-0.5">${legend}</p>

    <p class="text-[11px] uppercase font-bold tracking-wider text-gray-500 mb-1.5">Why transit fails</p>
    <div class="text-[11px] text-gray-400 space-y-1 mb-3">${reasons || "<p>No barriers found.</p>"}</div>

    <p class="text-[11px] uppercase font-bold tracking-wider text-gray-500 mb-1.5">Carpool seed groups</p>
    ${
      carpools
        ? `<div class="text-[11px] text-gray-400 mb-1">${carpools}</div>
           <p class="text-[10px] text-emerald-400/90 mb-3">${totalPooled} stranded staff share a pickup zone with at least one colleague.</p>`
        : `<p class="text-[11px] text-gray-500 mb-3">No zone has two or more stranded staff.</p>`
    }

    <details class="mb-2">
      <summary class="text-[11px] uppercase font-bold tracking-wider text-gray-500 cursor-pointer hover:text-gray-300">
        Per-employee detail (${data.employees.length})
      </summary>
      <div class="mt-2 max-h-64 overflow-y-auto">
        <table class="w-full text-[10px]">
          <thead class="text-gray-500 sticky top-0 bg-gray-800">
            <tr class="border-b border-gray-700">
              <th class="text-left py-1 font-semibold">Ref</th>
              <th class="text-left py-1 font-semibold">Zone</th>
              <th class="text-left py-1 font-semibold">Shift</th>
              <th class="text-left py-1 font-semibold">Verdict</th>
              <th class="text-right py-1 font-semibold">Transit</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>
    <p class="text-[10px] text-gray-500 leading-relaxed">
      ${escapeHTML(data.day_name)} ${escapeHTML(data.day)} · employees located by grid zone,
      never street address.
    </p>`;
}

function rank(verdict) {
  return { no_service: 0, gap: 1, marginal: 2, viable: 3 }[verdict] ?? 9;
}

function draw(data) {
  // Collapse employees into their zones so the map shows clusters, not a pile
  // of overlapping identical dots.
  const zones = new Map();
  data.employees.forEach((employee) => {
    if (!employee.origin || employee.origin.lon == null) return;
    const key = employee.origin_zone_id ?? `${employee.origin.lon},${employee.origin.lat}`;
    if (!zones.has(key)) {
      zones.set(key, {
        origin_zone_id: employee.origin_zone_id,
        lon: employee.origin.lon,
        lat: employee.origin.lat,
        employees: [],
        worst: "viable",
      });
    }
    const zone = zones.get(key);
    zone.employees.push(employee.employee_ref);
    if (rank(employee.verdict) < rank(zone.worst)) zone.worst = employee.verdict;
  });

  const points = [[data.worksite.lon, data.worksite.lat]];
  const features = [...zones.values()].map((zone) => {
    points.push([zone.lon, zone.lat]);
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [zone.lon, zone.lat] },
      properties: {
        origin_zone_id: zone.origin_zone_id,
        employee_count: zone.employees.length,
        employees: JSON.stringify(zone.employees),
        worst_verdict: zone.worst,
      },
    };
  });

  map.getSource("employer-employees-source").setData({
    type: "FeatureCollection",
    features,
  });

  map.getSource("employer-carpool-source").setData({
    type: "FeatureCollection",
    features: (data.carpool_candidates || [])
      .filter((candidate) => candidate.lon != null)
      .map((candidate) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [candidate.lon, candidate.lat] },
        properties: {
          employee_count: candidate.employee_count,
          origin_zone_id: candidate.origin_zone_id,
        },
      })),
  });

  setMarker("employer-worksite", [data.worksite.lon, data.worksite.lat], {
    color: "#f59e0b",
    label: `<strong>${escapeHTML(data.worksite.name)}</strong><br><span class="ct-muted">Worksite</span>`,
  });
  setVisibility(layers, true);
  fitToPoints(points, { padding: 70 });
}

export function clear() {
  clearMarker("employer-worksite");
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character])
  );
}
