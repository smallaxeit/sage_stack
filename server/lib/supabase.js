/**
 * supabase.js — lazy Supabase REST clients.
 *
 * STATUS: PARKED, not wired into the running app.
 *
 * Only lib/embeddings.js imports this, and that module is itself parked.
 * scripts/export-supabase.js builds its own client rather than depending on it.
 *
 * Kept deliberately: Supabase is hosted Postgres + pgvector and remains a
 * candidate backend for a public deploy. Two routes exist if that happens —
 * point the existing `postgres` store driver at Supabase's connection string
 * (Supabase is Postgres, so no new code), or promote this REST path into a
 * proper store driver for environments that cannot open a direct TCP
 * connection. Either needs a `subject` column added to the schema first, since
 * the tables below are single-tenant.
 *
 * See ARCHITECTURE_PLAN.md for that decision.
 */
import { createClient } from '@supabase/supabase-js';

// Lazy clients — created on first use so .env is loaded first
let _supabase = null;
let _supabasePublic = null;

function getSupabase() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      console.warn('[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — Supabase disabled');
      return null;
    }
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  }
  return _supabase;
}

function getSupabasePublic() {
  if (!_supabasePublic) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return null;
    _supabasePublic = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
  return _supabasePublic;
}

// Export as Proxy so callers use `supabase.from(...)` as normal
// but the client is only created on first property access
const handler = { get: (_, prop) => { const c = getSupabase(); return c ? c[prop] : null; } };
const handlerPublic = { get: (_, prop) => { const c = getSupabasePublic(); return c ? c[prop] : null; } };

export const supabase = new Proxy({}, handler);
export const supabasePublic = new Proxy({}, handlerPublic);
export default supabase;
