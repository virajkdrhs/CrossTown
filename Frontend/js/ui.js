/** Shared UI primitives: icons, status capsules, toasts, skeletons, tiles, CSV.
 *
 * Status capsules carry a dot *and* a label so status never depends on colour
 * alone, colours come from design tokens rather than scattered hex, toasts give
 * action feedback, and skeletons stand in for the word "Loading".
 */

/* ------------------------------------------------------------------ escaping */

export function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character])
  );
}

/* --------------------------------------------------------------------- icons */

// Line glyphs on a 24px grid, drawn to sit alongside system type.
const ICONS = {
  route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.6-2.8 2.6"/><path d="M12 16.8h.01"/>',
  sidebar: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M9.5 4.5v15"/>',
  bus: '<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M5 11h14"/><path d="M8 18v2.5M16 18v2.5"/><path d="M8.5 14.5h.01M15.5 14.5h.01"/>',
  walk: '<circle cx="13.5" cy="4.5" r="1.8"/><path d="M9 21l2.6-6.2L14 17v4"/><path d="M7 12.5l2.2-3.6 3.6.6 2.4 3 2.8.8"/><path d="M11.6 14.8 12.8 9.5"/>',
  car: '<path d="M5 16.5V12l2-5h10l2 5v4.5z"/><path d="M5 12h14"/><circle cx="8" cy="16.5" r="1.8"/><circle cx="16" cy="16.5" r="1.8"/>',
  van: '<path d="M3 17V8a2 2 0 0 1 2-2h10l5 5v6z"/><path d="M3 11h17"/><circle cx="7.5" cy="17.5" r="1.7"/><circle cx="16.5" cy="17.5" r="1.7"/>',
  building: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h.01M15 7h.01M9 11h.01M15 11h.01M9 15h.01M15 15h.01"/><path d="M10 21v-3h4v3"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3h3l2.6 12.2a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.6L21.5 8H6.2"/>',
  health: '<path d="M9.5 3.5h5v6h6v5h-6v6h-5v-6h-6v-5h6z"/>',
  book: '<path d="M4 19.5V5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5 2.5 2.5 0 0 0 6.5 23H20"/>',
  civic: '<path d="M3 21h18"/><path d="M5.5 21v-9M10 21v-9M14 21v-9M18.5 21v-9"/><path d="M12 3 3.5 8.5h17z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 7.5v6"/><path d="M12 17h.01"/>',
  "alert-circle": '<circle cx="12" cy="12" r="9"/><path d="M12 7.8v5"/><path d="M12 16.2h.01"/>',
  info: '<path d="M12 11v6"/><path d="M12 7.5h.01"/>',
  triangle: '<path d="M10.3 4 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 4a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/>',
  chart: '<path d="M4 20V11M10 20V5M16 20v-6M3 20h18"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M17.5 14.5a4.5 4.5 0 0 1 4 4.5"/>',
  download: '<path d="M12 4v11"/><path d="m7 10.5 5 4.5 5-4.5"/><path d="M5 20h14"/>',
  arrow: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
};

/** Inline SVG icon. `currentColor` lets the surrounding text set its colour. */
export function icon(name, size = 16, strokeWidth = 2) {
  const body = ICONS[name] || ICONS.info;
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
  );
}

/** Swap every `<span data-icon="name" data-size="n">` placeholder for its SVG. */
export function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((element) => {
    element.outerHTML = icon(element.dataset.icon, Number(element.dataset.size) || 16);
  });
}

/* -------------------------------------------------------------- status model */

/** One place defining what each verdict means, how it reads and how it colours.
 *
 * `token` is the text colour (contrast-safe on the panel), `fill` the vivid
 * system colour used for dots, bars and map symbols.
 */
export const VERDICT = {
  viable: {
    label: "Transit works",
    short: "Works",
    token: "--green",
    fill: "--green-fill",
    hex: "#4E9A63",
    rank: 4,
    blurb: "A bus can make this trip in a reasonable time.",
  },
  microtransit: {
    label: "LINK on demand",
    short: "LINK",
    token: "--teal",
    fill: "--teal-fill",
    hex: "#4A93B3",
    rank: 3,
    blurb: "No usable fixed route, but GRTC LINK covers this trip on demand, fare-free.",
  },
  marginal: {
    label: "Difficult",
    short: "Difficult",
    token: "--orange",
    fill: "--orange-fill",
    hex: "#C7843F",
    rank: 2,
    blurb: "Possible, but long or awkward enough that people give it up.",
  },
  gap: {
    label: "Transit gap",
    short: "Gap",
    token: "--red",
    fill: "--red-fill",
    hex: "#B4453C",
    rank: 1,
    blurb: "Transit exists, but it can't realistically serve this trip.",
  },
  no_service: {
    label: "No service",
    short: "None",
    token: "--red-deep",
    fill: "--red-deep",
    hex: "#7A2620",
    rank: 0,
    blurb: "No transit route reaches this trip at all.",
  },
};

export function verdictMeta(status) {
  return VERDICT[status] || VERDICT.gap;
}

export function verdictColor(status) {
  return `var(${verdictMeta(status).token})`;
}

export function verdictRank(status) {
  return verdictMeta(status).rank;
}

/** Dot + label capsule. Status is never conveyed by colour alone. */
export function statusPill(status, { size = "sm", label } = {}) {
  const meta = verdictMeta(status);
  const text = label || meta.label;
  const padding = size === "lg" ? "5px 12px 5px 10px" : "2px 8px 2px 7px";
  const fontSize = size === "lg" ? "13px" : "11px";
  return (
    `<span class="ct-pill" style="padding:${padding};font-size:${fontSize};` +
    `color:var(${meta.token});background:color-mix(in srgb, var(${meta.fill}) 14%, transparent)">` +
    `<span class="ct-pill-dot" style="background:var(${meta.fill})"></span>${escapeHTML(text)}</span>`
  );
}

/* -------------------------------------------------------------------- toasts */

let toastHost = null;

function ensureToastHost() {
  if (toastHost) return toastHost;
  toastHost = document.createElement("div");
  toastHost.className = "ct-toast-host";
  toastHost.setAttribute("role", "status");
  toastHost.setAttribute("aria-live", "polite");
  document.body.appendChild(toastHost);
  return toastHost;
}

const TOAST_ICONS = { ok: "check", error: "alert", warn: "alert", info: "info" };

export function toast(message, kind = "info", timeout = 4200) {
  const host = ensureToastHost();
  // Keep the stack short; a burst of actions should not bury the map.
  while (host.children.length >= 3) host.firstElementChild.remove();
  const node = document.createElement("div");
  node.className = `ct-toast ct-toast-${kind}`;
  node.innerHTML =
    `<span class="ct-toast-icon">${icon(TOAST_ICONS[kind] || "info", 13, 3)}</span>` +
    `<span>${escapeHTML(message)}</span>`;
  host.appendChild(node);
  // Force a frame so the entry transition runs.
  requestAnimationFrame(() => node.classList.add("ct-toast-in"));
  const remove = () => {
    node.classList.remove("ct-toast-in");
    setTimeout(() => node.remove(), 300);
  };
  node.addEventListener("click", remove);
  if (timeout) setTimeout(remove, timeout);
  return remove;
}

/* ----------------------------------------------------------------- skeletons */

export function skeleton(lines = 3, { heading = false } = {}) {
  const rows = [];
  if (heading) rows.push('<div class="ct-skel" style="height:120px;border-radius:16px;margin-bottom:4px"></div>');
  for (let i = 0; i < lines; i += 1) {
    const width = 100 - (i % 3) * 14;
    rows.push(`<div class="ct-skel" style="height:14px;width:${width}%"></div>`);
  }
  return `<div class="ct-skel-stack">${rows.join("")}</div>`;
}

/** Empty or error state. `glyph` is an icon name. */
export function emptyState(glyph, title, body, actionHTML = "") {
  return `<div class="ct-empty">
    <div class="ct-empty-icon">${icon(glyph, 22)}</div>
    <p class="ct-empty-title">${escapeHTML(title)}</p>
    <p class="ct-empty-body">${escapeHTML(body)}</p>
    ${actionHTML}
  </div>`;
}

/* ---------------------------------------------------------------- formatting */

export function money(value) {
  const number = Number(value) || 0;
  return number >= 1000
    ? `$${Math.round(number).toLocaleString()}`
    : `$${number.toFixed(2).replace(/\.00$/, "")}`;
}

export function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm || `${singular}s`}`;
}

/** Metric tile used across the Commute, Employer and Carpool panels.
 *
 * `value` is trusted markup built by the caller from numbers; label and sub are
 * escaped here.
 */
export function tile(label, value, sub = "", accent = "") {
  return `<div class="ct-tile">
    <p class="ct-tile-label">${escapeHTML(label)}</p>
    <p class="ct-tile-value" ${accent ? `style="color:${accent}"` : ""}>${value}</p>
    ${sub ? `<p class="ct-tile-sub">${escapeHTML(sub)}</p>` : ""}
  </div>`;
}

/** Section heading inside a results panel. */
export function sectionTitle(text, aside = "") {
  return `<h2 class="section-title">${escapeHTML(text)}${
    aside ? ` <span class="aside">${escapeHTML(aside)}</span>` : ""
  }</h2>`;
}

/* -------------------------------------------------------------- CSV download */

export function toCSV(rows, columns) {
  const escapeCell = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = columns.map((column) => escapeCell(column.label)).join(",");
  const body = rows
    .map((row) => columns.map((column) => escapeCell(column.get(row))).join(","))
    .join("\n");
  return `${header}\n${body}`;
}

export function downloadCSV(filename, csv) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------- buttons */

/** Run an async action with a busy label and spinner. */
export async function withBusy(button, busyLabel, action) {
  const original = button.innerHTML;
  button.disabled = true;
  button.dataset.busy = "1";
  button.textContent = busyLabel;
  try {
    return await action();
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
    button.innerHTML = original;
  }
}

/** Keep a range input's filled track in step with its value. */
export function syncRangeFill(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty("--fill-pct", `${pct}%`);
}
