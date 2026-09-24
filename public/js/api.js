const cache = new Map();

/** GET JSON. Responses are memoised for 60 s (the server refreshes data once a day). */
export async function api(path, params = {}, { fresh = false } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const url = `/api/${path}${qs.size ? `?${qs}` : ''}`;
  const hit = cache.get(url);
  if (!fresh && hit && Date.now() - hit.at < 60000) return hit.data;

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    let body = null;
    try {
      body = await res.json();
      if (body && body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  return data;
}
