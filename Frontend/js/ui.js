/** Shared UI primitives.
 *
 * Patterns borrowed from the dental CRM in this workspace: semantic status pills
 * that carry a dot *and* a label so status never depends on colour alone, design
 * tokens rather than scattered hex, toasts for action feedback, and skeletons
 * instead of the word "Loading".
 */

/* ------------------------------------------------------------------ escaping */

export function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character])
  );
}

/* -------------------------------------------------------------- status model */

/** One place defining what each verdict means, how it reads and how it colours. */
export const VERDICT = {
  viable: {
    label: "Transit works",
    short: "Works",
    token: "--ct-ok",
    rank: 4,
    blurb: "A bus can do this trip in reasonable time.",
  },
  microtransit: {
    label: "LINK on demand",
    short: "LINK",
    token: "--ct-info",
    rank: 3,
    blurb: "No usable fixed route, but GRTC LINK covers this trip on demand, fare-free.",
  },
  marginal: {
    label: "Difficult",
    short: "Difficult",
    token: "--ct-warn",
    rank: 2,
    blurb: "Possible, but long or awkward enough that people give it up.",
  },
  gap: {
    label: "Transit gap",
    short: "Gap",
    token: "--ct-bad",
    rank: 1,
    blurb: "Transit exists but cannot realistically serve this trip.",
  },
  no_service: {
    label: "No service",
    short: "None",
    token: "--ct-critical",
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

/** Dot + label pill. Status is never conveyed by colour alone. */
export function statusPill(status, { size = "sm", label } = {}) {
  const meta = verdictMeta(status);
  const text = label || meta.label;
  const padding = size === "lg" ? "4px 10px" : "2px 7px";
  const fontSize = size === "lg" ? "11px" : "10px";
  return (
    `<span class="ct-pill" style="padding:${padding};font-size:${fontSize};` +
    `color:var(${meta.token});background:color-mix(in srgb, var(${meta.token}) 14%, transparent);` +
    `border-color:color-mix(in srgb, var(${meta.token}) 35%, transparent)">` +
    `<span class="ct-pill-dot" style="background:var(${meta.token})"></span>${escapeHTML(text)}</span>`
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

export function toast(message, kind = "info", timeout = 4200) {
  const host = ensureToastHost();
  const node = document.createElement("div");
  node.className = `ct-toast ct-toast-${kind}`;
  node.innerHTML =
    `<span class="ct-toast-icon">${
      { ok: "✓", error: "!", warn: "!", info: "i" }[kind] || "i"
    }</span><span>${escapeHTML(message)}</span>`;
  host.appendChild(node);
  // Force a frame so the entry transition runs.
  requestAnimationFrame(() => node.classList.add("ct-toast-in"));
  const remove = () => {
    node.classList.remove("ct-toast-in");
    setTimeout(() => node.remove(), 220);
  };
  node.addEventListener("click", remove);
  if (timeout) setTimeout(remove, timeout);
  return remove;
}

/* ----------------------------------------------------------------- skeletons */

export function skeleton(lines = 3, { heading = false } = {}) {
  const rows = [];
  if (heading) rows.push('<div class="ct-skel" style="height:38px;margin-bottom:10px"></div>');
  for (let i = 0; i < lines; i += 1) {
    const width = 100 - (i % 3) * 12;
    rows.push(`<div class="ct-skel" style="height:11px;width:${width}%"></div>`);
  }
  return `<div class="ct-skel-stack">${rows.join("")}</div>`;
}

export function emptyState(icon, title, body, actionHTML = "") {
  return `<div class="ct-empty">
    <div class="ct-empty-icon" aria-hidden="true">${icon}</div>
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

/** Metric tile used across the Commute, Employer and Carpool panels. */
export function tile(label, value, sub = "", accent = "") {
  return `<div class="ct-tile">
    <p class="ct-tile-label">${escapeHTML(label)}</p>
    <p class="ct-tile-value" ${accent ? `style="color:${accent}"` : ""}>${value}</p>
    ${sub ? `<p class="ct-tile-sub">${escapeHTML(sub)}</p>` : ""}
  </div>`;
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

/** Run an async action with a busy label, catching and toasting failures. */
export async function withBusy(button, busyLabel, action) {
  const original = button.textContent;
  button.disabled = true;
  button.dataset.busy = "1";
  button.textContent = busyLabel;
  try {
    return await action();
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
    button.textContent = original;
  }
}
