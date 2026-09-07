/**
 * api.js — one place that knows about the admin key.
 *
 * It was previously known only to AdminPanel, so uploading from the Knowledge
 * screen returned 401 with no way to supply a key from there. Anything that
 * spends, writes or deletes must go through here.
 */

const KEY = 'ss-admin-key';

export const getAdminKey = () => {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
};

export const setAdminKey = (v) => {
  try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch { /* private mode */ }
};

export const adminHeaders = () => {
  const k = getAdminKey();
  return k ? { 'x-admin-key': k } : {};
};

/**
 * fetch with the admin key attached.
 *
 * A 401 is turned into a message naming the fix, because the raw status tells
 * the user nothing about what to do — the key is entered in the Admin panel.
 */
export async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...adminHeaders(), ...(opts.headers || {}) },
  });

  if (res.status === 401) {
    const err = new Error(
      'This action needs the admin key. Open the Admin panel (⚙) and enter it, then try again.',
    );
    err.status = 401;
    throw err;
  }
  return res;
}

/** apiFetch, parsed as JSON, surfacing a server-supplied error message. */
export async function apiJson(path, opts = {}) {
  const res = await apiFetch(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.message || `Request failed (${res.status})`);
  return body;
}
