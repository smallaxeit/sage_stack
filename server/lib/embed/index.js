/**
 * embed/index.js — pluggable embeddings (ARCHITECTURE_PLAN.md §4.5).
 *
 *   EMBED_DRIVER=voyage   Voyage AI (default) — best retrieval quality, costs
 *                         money, needs a key, one network call per query
 *   EMBED_DRIVER=local    in-process ONNX model — free, offline, no key
 *
 * An embedder is deliberately NOT a searcher. It turns text into vectors; the
 * store owns retrieval. That split is what lets the same embedder serve the
 * files driver and the postgres driver.
 *
 * ─── The mismatch guard ──────────────────────────────────────────────────────
 * Vectors from different models are NOT interchangeable, and a mismatch does
 * not error — it silently returns confident nonsense, ranking by a similarity
 * that means nothing. That is the worst failure mode in this whole system, so
 * every subject records the model and dimension it was embedded with, and
 * assertEmbedderMatchesSubject() refuses the query rather than answering badly.
 */

import { createVoyageEmbedder } from './voyage.js';
import { createLocalEmbedder } from './local.js';

export const EMBED_DRIVERS = ['voyage', 'local'];

/**
 * Build an embedder. Options override env so a subject profile's embed block
 * can drive this directly.
 *
 *   createEmbedder()                                    -> EMBED_DRIVER, or voyage
 *   createEmbedder({ driver: 'voyage', model: 'voyage-3.5', dim: 1024 })
 *   createEmbedder(profile.embed)
 */
export function createEmbedder(opts = {}) {
  const driver = opts.driver || process.env.EMBED_DRIVER || 'voyage';
  switch (driver) {
    case 'voyage': return createVoyageEmbedder(opts);
    case 'local':  return createLocalEmbedder(opts);
    default:
      throw new Error(`Unknown EMBED_DRIVER: ${driver} (expected one of ${EMBED_DRIVERS.join(', ')})`);
  }
}

/**
 * Refuse to search a subject with an embedder that did not build it.
 *
 * `subject` is a store manifest / subject row: { embedModel, dim }.
 * Pass { allowUnknownModel: true } for subjects imported before model was
 * recorded — dimension is still enforced.
 */
export function assertEmbedderMatchesSubject(embedder, subject, { allowUnknownModel = false } = {}) {
  if (!subject) throw new Error('assertEmbedderMatchesSubject: no subject metadata');

  if (subject.dim != null && embedder.dim !== subject.dim) {
    throw new Error(
      `Embedding dimension mismatch: subject "${subject.slug ?? '?'}" was built at ${subject.dim} dims, ` +
      `but the active embedder (${embedder.driver}/${embedder.model}) produces ${embedder.dim}. ` +
      `Re-embed the subject, or switch EMBED_DRIVER back.`,
    );
  }

  const recorded = subject.embedModel;
  if (recorded == null) {
    if (!allowUnknownModel) {
      throw new Error(
        `Subject "${subject.slug ?? '?'}" does not record which model embedded it, so a query cannot be ` +
        `verified as compatible. Re-embed it, or pass { allowUnknownModel: true } if you are certain.`,
      );
    }
    return true;
  }

  if (recorded !== embedder.model) {
    throw new Error(
      `Embedding model mismatch: subject "${subject.slug ?? '?'}" was built with "${recorded}", ` +
      `but the active embedder is "${embedder.model}". Vectors from different models are not ` +
      `comparable — the search would return plausible nonsense. Re-embed the subject to switch models.`,
    );
  }
  return true;
}

/** L2 norm, exported because both drivers and the tests want it. */
export function l2norm(vec) {
  let s = 0;
  for (let i = 0; i < vec.length; i++) s += vec[i] * vec[i];
  return Math.sqrt(s);
}

/** Normalize in place to unit length. No-op on a zero vector. */
export function normalize(vec) {
  const n = l2norm(vec);
  if (n === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] /= n;
  return vec;
}
