/** API access.
 *
 * The app runs in two shapes and must work in both without configuration:
 *
 *   deployed  — frontend and API share one origin, API under /api
 *   local dev — static files on :5500, uvicorn on :8000
 *
 * Guessing from the port was fragile (a same-origin server on any other port
 * guessed wrong), so resolve it once by asking: try this origin first, fall back
 * to the local API port. The answer is cached for the life of the page.
 */

const LOCAL_API = "http://127.0.0.1:8000";
const PROBE = "/api/v1/health";

let resolved = null;
let resolving = null;

async function probe(base) {
  try {
    const response = await fetch(`${base}${PROBE}`, { method: "GET" });
    return response.ok;
  } catch (_) {
    return false;
  }
}

export async function apiBase() {
  if (resolved !== null) return resolved;
  if (resolving) return resolving;
  resolving = (async () => {
    for (const candidate of ["", LOCAL_API]) {
      // Skip the same-origin probe on file://, where it can never succeed.
      if (candidate === "" && location.protocol === "file:") continue;
      if (await probe(candidate)) {
        resolved = candidate;
        return resolved;
      }
    }
    // Nothing answered. Settle on same-origin so errors name the real URL.
    resolved = "";
    return resolved;
  })();
  return resolving;
}

/** Fetch JSON, surfacing FastAPI's `detail` message as the Error text. */
export async function request(path, options) {
  const base = await apiBase();
  const response = await fetch(`${base}${path}`, options);
  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body && body.detail) {
        detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      }
    } catch (_) {
      /* error body was not JSON */
    }
    throw new Error(detail);
  }
  return response.json();
}

export const getJSON = (path) => request(path);

export const postJSON = (path, body) =>
  request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
