export const API_BASE_URL = "http://127.0.0.1:8000";

/** Fetch JSON, surfacing FastAPI's `detail` message as the Error text. */
export async function request(path, options) {
  const response = await fetch(`${API_BASE_URL}${path}`, options);
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
