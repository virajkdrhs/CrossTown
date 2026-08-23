/** Employer dashboard: which staff cannot reach this worksite on transit.
 *
 * Employees are located by access-grid zone, never by street address - the same
 * rule the live product would follow, so a demo screenshot can never leak a home
 * location.
 */

import { postJSON } from "./api.js";
import { map, setMarker, clearMarker, fitToPoints, setVisibility, emptyCollection } from "./map.js";
import * as roster from "./roster.js";
import {
  escapeHTML, statusPill, verdictColor, verdictRank, verdictMeta, tile, money,
  toast, skeleton, emptyState, withBusy, toCSV, downloadCSV,
} from "./ui.js";

const WORKSITE_PRESETS = [
  { label: "Innsbrook office park", lat: 37.658, lon: -77.57 },
  { label: "Short Pump retail corridor", lat: 37.65, lon: -77.61 },
  { label: "Downtown Richmond", lat: 37.5407, lon: -77.436 },
  { label: "Richmond International Airport", lat: 37.5052, lon: -77.3197 },
  { label: "White Oak Village", lat: 37.4936, lon: -77.3742 },
];

const VERDICT_COLORS = {
  viable: "#34d399",
  microtransit: "#38bdf8",
  marginal: "#fbbf24",
  gap: "#f87171",
  no_service: "#dc2626",
};

const REASON_LABELS = {
  link_door_to_door: "LINK covers the trip on demand",
  link_connection: "LINK could bridge to a bus",
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

  document.getElementById("employer-result").innerHTML = emptyState(
    "🏢",
    "No analysis yet",
    "Load the demo roster and pick a worksite. Every employee is checked against the live schedule for their own shift."
  );

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
        "microtransit", VERDICT_COLORS.microtransit,
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
      `<span style="color:var(--ct-bad)">${escapeHTML(err.message)}</span>`;
    toast(err.message, "error");
  } finally {
    button.disabled = false;
  }
}

function reflectRoster() {
  const status = document.getElementById("employer-roster-status");
  if (roster.isLoaded()) {
    status.innerHTML =
      `<span style="color:var(--ct-ok)">${roster.describe()}</span> · ` +
      `<span style="color:var(--ct-warn)">synthetic demo data</span>`;
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

  const panel = document.getElementById("employer-result");
  panel.innerHTML = skeleton(7, { heading: true });
  try {
    await withBusy(button, "Analysing…", async () => {
      const data = await postJSON("/api/v2/roster/gaps", payload);
      lastReport = data;
      render(data);
      draw(data);
      toast(
        `${data.summary.in_gap} of ${data.summary.employees_analysed} staff cannot reach ${data.worksite.name}`,
        data.summary.in_gap ? "warn" : "ok"
      );
    });
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
    panel.innerHTML = emptyState("⚠️", "Analysis failed", err.message);
    toast(err.message, "error");
  }
}

let lastReport = null;

function exportCSV() {
  if (!lastReport) return;
  const csv = toCSV(lastReport.employees, [
    { label: "employee_ref", get: (r) => r.employee_ref },
    { label: "origin_zone_id", get: (r) => r.origin_zone_id },
    { label: "shift_start", get: (r) => r.shift_start },
    { label: "shift_end", get: (r) => r.shift_end },
    { label: "has_vehicle", get: (r) => (r.has_vehicle ? "yes" : "no") },
    { label: "verdict", get: (r) => r.verdict },
    { label: "transit_minutes", get: (r) => r.transit_minutes },
    { label: "depart_by", get: (r) => r.depart_by },
    { label: "transfers", get: (r) => r.transfers },
    { label: "link_option", get: (r) => (r.has_microtransit_option ? "yes" : "no") },
    { label: "annual_driving_cost_usd", get: (r) => r.drive_cost_per_year_usd },
    { label: "reasons", get: (r) => (r.reasons || []).join("; ") },
  ]);
  const site = (lastReport.worksite.name || "worksite").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  downloadCSV(`crosstown-gap-report-${site}-${lastReport.day}.csv`, csv);
  toast("Gap report exported as CSV", "ok");
}

function render(data) {
  const summary = data.summary;
  const panel = document.getElementById("employer-result");
  const withLink = data.employees.filter((employee) => employee.has_microtransit_option).length;
  const annualCost = data.employees.reduce(
    (total, employee) => total + (employee.drive_cost_per_year_usd || 0),
    0
  );

  const headline = `
    <div class="rounded-xl p-3 mb-3 text-center" style="border:1px solid color-mix(in srgb, var(--ct-bad) 40%, transparent);background:color-mix(in srgb, var(--ct-bad) 8%, transparent)">
      <p class="text-[10px] uppercase tracking-wider" style="color:var(--ct-text-muted)">Staff who cannot reach this site on transit</p>
      <p class="text-3xl font-extrabold my-0.5" style="color:var(--ct-bad)">${summary.in_gap}
        <span class="text-lg" style="color:var(--ct-text-dim)">/ ${summary.employees_analysed}</span></p>
      <p class="text-[11px]" style="color:var(--ct-text-muted)">${summary.pct_in_gap}% of the roster ·
        <span style="color:var(--ct-warn)">${summary.in_gap_without_vehicle} of them own no car</span></p>
    </div>`;

  const order = ["viable", "microtransit", "marginal", "gap", "no_service"];
  const verdictBar = order
    .map((key) => {
      const count = summary.verdicts[key] || 0;
      if (!count) return "";
      const width = (100 * count) / summary.employees_analysed;
      return `<div style="width:${width}%;background:${VERDICT_COLORS[key]}" title="${key}: ${count}"></div>`;
    })
    .join("");

  const legend = order
    .filter((key) => summary.verdicts[key])
    .map((key) => statusPill(key, { label: `${verdictMeta(key).short} ${summary.verdicts[key]}` }))
    .join(" ");

  const tiles = [
    tile("Roster", `${summary.employees_analysed}`, "staff analysed"),
    tile("No car", `${summary.in_gap_without_vehicle}`, "stranded, car-free", "var(--ct-warn)"),
    tile("LINK option", `${withLink}`, "on-demand available", "var(--ct-info)"),
    tile("Driving cost", money(annualCost), "roster total per year", "var(--ct-warn)"),
  ].join("");

  const reasons = Object.entries(summary.top_reasons || {})
    .map(
      ([code, count]) =>
        `<div class="flex justify-between gap-3"><span>${escapeHTML(
          REASON_LABELS[code] || code
        )}</span><span class="font-semibold" style="color:var(--ct-text)">${count}</span></div>`
    )
    .join("");

  const carpools = (data.carpool_candidates || [])
    .map(
      (candidate) =>
        `<div class="flex justify-between items-center gap-2 py-1" style="border-bottom:1px solid var(--ct-border-soft)">
           <span>Zone ${candidate.origin_zone_id}</span>
           <span class="font-semibold" style="color:var(--ct-ok)">${candidate.employee_count} riders</span>
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
      <tr style="border-bottom:1px solid var(--ct-border-soft)">
        <td class="py-1 pr-2 whitespace-nowrap" style="color:var(--ct-text)">${escapeHTML(employee.employee_ref)}</td>
        <td class="py-1 pr-2" style="color:var(--ct-text-dim)">${employee.origin_zone_id ?? "—"}</td>
        <td class="py-1 pr-2 whitespace-nowrap" style="color:var(--ct-text-dim)">${escapeHTML(
          employee.shift_start || "—"
        )}</td>
        <td class="py-1 pr-2">${statusPill(employee.verdict, { label: verdictMeta(employee.verdict).short })}</td>
        <td class="py-1 text-right whitespace-nowrap" style="color:var(--ct-text-muted)">${
          employee.transit_minutes != null ? `${employee.transit_minutes}m` : "—"
        }</td>
      </tr>`
    )
    .join("");

  panel.innerHTML = `
    ${headline}
    <div class="grid grid-cols-2 gap-2 mb-3">${tiles}</div>
    <div class="mb-1.5 h-2 rounded-full overflow-hidden flex" style="background:var(--ct-raised)">${verdictBar}</div>
    <div class="flex flex-wrap gap-1 mb-3">${legend}</div>

    <p class="text-[11px] uppercase font-bold tracking-wider mb-1.5" style="color:var(--ct-text-dim)">Why transit fails</p>
    <div class="text-[11px] space-y-1 mb-3" style="color:var(--ct-text-muted)">${
      reasons || "<p>No barriers found.</p>"
    }</div>

    <p class="text-[11px] uppercase font-bold tracking-wider mb-1.5" style="color:var(--ct-text-dim)">Carpool seed groups</p>
    ${
      carpools
        ? `<div class="text-[11px] mb-1" style="color:var(--ct-text-muted)">${carpools}</div>
           <p class="text-[10px] mb-3" style="color:var(--ct-ok)">${totalPooled} stranded staff share a pickup zone with at least one colleague.</p>
           <button id="employer-to-carpool" class="w-full text-xs font-bold py-2 rounded-lg mb-3 transition"
                   style="background:var(--ct-brand);color:var(--ct-bg)">Build carpools from these groups</button>`
        : `<p class="text-[11px] mb-3" style="color:var(--ct-text-dim)">No zone has two or more stranded staff.</p>`
    }

    <details class="mb-2">
      <summary class="text-[11px] uppercase font-bold tracking-wider cursor-pointer" style="color:var(--ct-text-dim)">
        Per-employee detail (${data.employees.length})
      </summary>
      <div class="mt-2 max-h-64 overflow-y-auto ct-scroll">
        <table class="w-full text-[10px]">
          <thead class="sticky top-0" style="color:var(--ct-text-dim);background:var(--ct-surface)">
            <tr style="border-bottom:1px solid var(--ct-border)">
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

    <button id="employer-export" class="w-full text-xs font-semibold py-2 rounded-lg transition mb-2"
            style="border:1px solid var(--ct-border);color:var(--ct-text-muted);background:var(--ct-raised)">
      Export gap report (CSV)
    </button>

    <p class="text-[10px] leading-relaxed" style="color:var(--ct-text-dim)">
      ${escapeHTML(data.day_name)} ${escapeHTML(data.day)} · staff located by grid zone, never street address.
    </p>`;

  document.getElementById("employer-export").addEventListener("click", exportCSV);
  const toCarpool = document.getElementById("employer-to-carpool");
  if (toCarpool) {
    toCarpool.addEventListener("click", () => {
      window.dispatchEvent(
        new CustomEvent("crosstown:show-carpool", {
          detail: { worksite: data.worksite, shift_start: null },
        })
      );
    });
  }
}

function rank(verdict) {
  return verdictRank(verdict);
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

