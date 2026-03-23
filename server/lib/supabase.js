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
