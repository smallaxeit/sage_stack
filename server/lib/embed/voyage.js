/**
 * embed/voyage.js — Voyage AI embeddings.
 *
 * Standardised on voyage-3.5 (ARCHITECTURE_PLAN.md §4.5). The old build used
 * voyage-3; both are 1024-dim so the schema is identical, but VECTORS FROM THE
 * TWO MODELS ARE NOT INTERCHANGEABLE. Switching is a re-embed, not a swap —
 * which is why the subject manifest records the model and the mismatch guard
 * refuses a cross-model query.
 *
 * Anthropic has no embeddings API; Voyage is the recommended pairing.
 */

import { normalise } from './index.js';

const VOYAGE_API = 'https://api.voyageai.com/v1/embeddings';

/** Voyage accepts at most 128 inputs per request. */
const MAX_BATCH = 128;

/** voyage-3.5 supports these output dimensions via Matryoshka truncation. */
const SUPPORTED_DIMS = { 'voyage-3.5': [256, 512, 1024, 2048], 'voyage-3.5-lite': [256, 512, 1024, 2048] };

export function createVoyageEmbedder(opts = {}) {
  const model  = opts.model || process.env.VOYAGE_MODEL || 'voyage-3.5';
  const dim    = opts.dim ?? Number(process.env.EMBED_DIM || 1024);
  const apiKey = opts.apiKey || process.env.VOYAGE_API_KEY;
  // Injectable for tests; defaults to global fetch.
  const doFetch = opts.fetch || globalThis.fetch;
  const maxRetries = opts.maxRetries ?? 5;
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));

  const allowed = SUPPORTED_DIMS[model];
  if (allowed && !allowed.includes(dim)) {
    throw new Error(`${model} supports dimensions ${allowed.join('/')}, not ${dim}`);
  }

  function requireKey() {
    if (!apiKey) {
      throw new Error(
        'VOYAGE_API_KEY is not set.\n' +
        '  Add it to server/.env, or switch to the local embedder with EMBED_DRIVER=local.',
      );
    }
  }

  async function callVoyage(texts, inputType) {
    requireKey();
    const body = { model, input: texts, input_type: inputType };
    // Only send output_dimension when the model actually supports it, so an
    // unknown/older model isn't rejected for an unexpected field.
    if (allowed) body.output_dimension = dim;

    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(VOYAGE_API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const json = await res.json();
        // Voyage does not guarantee response order matches input order; it
        // returns an `index` per item. Sort by it rather than trusting order.
        const out = json.data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map(d => d.embedding);
        if (out.length !== texts.length) {
          throw new Error(`Voyage returned ${out.length} embeddings for ${texts.length} inputs`);
        }
        for (const v of out) {
          if (v.length !== dim) throw new Error(`Voyage returned ${v.length} dims, expected ${dim}`);
        }
        return out;
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= maxRetries) {
        throw new Error(`Voyage API error: ${res.status} ${await res.text()}`);
      }
      // 429s here are usually a token-per-minute cap during a bulk build, so
      // back off in tens of seconds rather than milliseconds.
      await sleep(20000 * Math.pow(2, attempt));
    }
  }

  return {
    driver: 'voyage',
    model,
    dim,

    /** Embed corpus text. Batches automatically; preserves input order. */
    async embedDocuments(texts, { onProgress } = {}) {
      if (!texts.length) return [];
      const out = [];
      for (let i = 0; i < texts.length; i += MAX_BATCH) {
        const batch = texts.slice(i, i + MAX_BATCH);
        out.push(...await callVoyage(batch, 'document'));
        if (onProgress) onProgress({ done: out.length, total: texts.length });
      }
      return out;
    },

    /** Embed a search query. input_type=query is asymmetric with documents. */
    async embedQuery(text) {
      const [vec] = await callVoyage([text], 'query');
      return vec;
    },
  };
}

export { normalise };
