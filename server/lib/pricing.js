/**
 * pricing.js — what a question actually cost.
 *
 * The number is worth showing because it is not intuitive, and estimating it
 * from the outside goes wrong in both directions. A measured Rx question:
 * ~$0.17, against a ~$0.02 estimate made from character counts — 1.5x low on
 * tokens (dense labeling runs 2.5 chars/token, not the ~3.7 of prose) and
 * wrong again in assuming cache hits that ranked retrieval never gets, because
 * its passages differ every question.
 *
 * Prices live in config/models.json, beside the models they belong to. They do
 * change — a wrong price is worse than no price, so an unrecognized model
 * reports null and the UI shows nothing rather than a confident fabrication.
 */

import { modelConfig } from './models.js';

const config = modelConfig();

/** Base rates. Cache rates are derived — see CACHE_MULTIPLIER. */
export const PRICES = config.pricing.text;

/**
 * Cache pricing is a multiple of a model's input rate rather than a separate
 * number per model, which is how it is actually billed: a 5-minute write costs
 * 1.25x input, a 1-hour write 2x, and a read a tenth.
 */
export const CACHE_MULTIPLIER = config.cacheMultiplier;

/** Embedding models, priced the same way. */
export const EMBED_PRICES = config.pricing.embedding;

/** Longest matching prefix, so a dated id like `claude-sonnet-5-20260101` resolves. */
function lookup(table, model) {
  if (!model) return null;
  if (table[model]) return table[model];
  let best = null;
  for (const [key, value] of Object.entries(table)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) best = { key, value };
  }
  return best?.value ?? null;
}

/**
 * Cost of one message, from the usage the API reports.
 *
 * Returns null for a model with no price on file. Every caller must handle
 * that — showing "$0.00" for an unknown model would read as free.
 */
export function priceMessage(model, usage, { cacheTtl = '5m' } = {}) {
  const rate = lookup(PRICES, model);
  if (!rate || !usage) return null;

  // `input_tokens` excludes anything served from or written to the cache; the
  // three are disjoint and must be priced separately, not summed.
  const uncached = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;

  const writeRate = rate.input * (cacheTtl === '1h' ? CACHE_MULTIPLIER.write1h : CACHE_MULTIPLIER.write5m);
  const per = (tokens, r) => (tokens / 1e6) * r;

  const parts = {
    uncached:   per(uncached,   rate.input),
    cacheRead:  per(cacheRead,  rate.input * CACHE_MULTIPLIER.read),
    cacheWrite: per(cacheWrite, writeRate),
    output:     per(output,     rate.output),
  };

  return {
    model,
    usd: parts.uncached + parts.cacheRead + parts.cacheWrite + parts.output,
    parts,
    tokens: { uncached, cacheRead, cacheWrite, output },
    // What the reader most wants to know when the number jumps: was the prefix
    // still warm? A write means it was not.
    cacheHit: cacheRead > 0 && cacheWrite === 0,
  };
}

/** Cost of embedding a query. Fractions of a cent, but it is not zero. */
export function priceEmbedding(model, tokens) {
  const rate = lookup(EMBED_PRICES, model);
  if (rate == null || !tokens) return null;
  return { model, usd: (tokens / 1e6) * rate, tokens };
}

/**
 * Add up the calls a single question made — the answer, plus any query rewrite
 * or embedding along the way.
 *
 * `unpriced` names models that had no price on file, so the total can be shown
 * as a floor ("at least") rather than silently under-reporting.
 */
export function totalCost(entries) {
  const priced = entries.filter(Boolean);
  const unpriced = entries.filter(e => e === null).length;
  return {
    usd: priced.reduce((sum, e) => sum + e.usd, 0),
    calls: priced,
    complete: unpriced === 0,
  };
}

/**
 * Human-readable, and honest about scale. A question can cost less than a
 * hundredth of a cent, and "$0.00" would be a lie of rounding.
 */
export function formatUSD(usd) {
  if (usd == null) return null;
  if (usd === 0) return '$0';
  if (usd < 0.01) return `${(usd * 100).toFixed(2)}¢`;
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}
