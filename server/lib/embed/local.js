/**
 * embed/local.js — in-process embeddings, no API key, no network after the
 * first model download.
 *
 * The dependency is LAZY and OPTIONAL. Nothing here is imported unless
 * EMBED_DRIVER=local, so a Voyage-only install never pays for the ONNX runtime.
 *
 *   npm --prefix server install @huggingface/transformers
 *
 * Tradeoffs against Voyage, stated plainly:
 *   - free, offline, private; no per-query cost
 *   - lower retrieval quality than voyage-3.5 on most corpora
 *   - different dimension (384 for the default model, vs 1024), so switching
 *     is a full re-embed and a new subject — see the mismatch guard in index.js
 *   - first use downloads model weights to a local cache (~90MB for MiniLM)
 *
 * Some models are trained asymmetrically and expect a prefix on queries (BGE
 * in particular). `queryPrefix` / `documentPrefix` cover that; the default
 * model needs neither.
 */

import { normalize } from './index.js';

/** Known model -> dimension, so a mismatch is caught before any work happens. */
const KNOWN_DIMS = {
  'Xenova/all-MiniLM-L6-v2': 384,
  'Xenova/all-MiniLM-L12-v2': 384,
  'Xenova/bge-small-en-v1.5': 384,
  'Xenova/bge-base-en-v1.5': 768,
  'Xenova/gte-small': 384,
  'nomic-ai/nomic-embed-text-v1.5': 768,
};

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

async function loadTransformers() {
  // v3 package name first, then the older Xenova one.
  for (const pkg of ['@huggingface/transformers', '@xenova/transformers']) {
    try { return await import(pkg); } catch { /* try the next */ }
  }
  throw new Error(
    'The local embedder needs a transformers runtime, which is an optional dependency.\n' +
    '  Install it:  npm --prefix server install @huggingface/transformers\n' +
    '  Or switch back to Voyage:  EMBED_DRIVER=voyage',
  );
}

export function createLocalEmbedder(opts = {}) {
  const model = opts.model || process.env.LOCAL_EMBED_MODEL || DEFAULT_MODEL;
  const known = KNOWN_DIMS[model];
  const dim   = opts.dim ?? (known ?? Number(process.env.EMBED_DIM || 0));

  if (!dim) {
    throw new Error(
      `Unknown local embedding model "${model}" — pass an explicit dim, or use one of: ` +
      Object.keys(KNOWN_DIMS).join(', '),
    );
  }
  if (known && dim !== known) {
    throw new Error(`${model} produces ${known} dims, not ${dim}`);
  }

  const queryPrefix    = opts.queryPrefix ?? '';
  const documentPrefix = opts.documentPrefix ?? '';
  const batchSize      = opts.batchSize ?? 32;

  // Built once, on first use, then reused. Loading is slow; embedding is not.
  let pipePromise = null;
  function getPipe() {
    if (!pipePromise) {
      pipePromise = (async () => {
        const { pipeline } = await loadTransformers();
        return pipeline('feature-extraction', model, opts.pipelineOptions);
      })();
    }
    return pipePromise;
  }

  async function embed(texts, prefix) {
    const pipe = await getPipe();
    const out = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map(t => prefix + t);
      // Mean pooling + L2 normalization is the standard recipe for these
      // sentence-transformer models; without pooling you get per-token vectors.
      const res = await pipe(batch, { pooling: 'mean', normalize: true });
      const data = res.tolist ? res.tolist() : res;
      for (const vec of data) {
        if (vec.length !== dim) throw new Error(`${model} returned ${vec.length} dims, expected ${dim}`);
        out.push(vec);
      }
    }
    return out;
  }

  return {
    driver: 'local',
    model,
    dim,

    async embedDocuments(texts, { onProgress } = {}) {
      if (!texts.length) return [];
      const out = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        out.push(...await embed(texts.slice(i, i + batchSize), documentPrefix));
        if (onProgress) onProgress({ done: out.length, total: texts.length });
      }
      return out;
    },

    async embedQuery(text) {
      const [vec] = await embed([text], queryPrefix);
      return vec;
    },
  };
}

export { normalize, KNOWN_DIMS };
