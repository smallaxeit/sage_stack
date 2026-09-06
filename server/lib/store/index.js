/**
 * store/index.js — storage driver selection.
 *
 * Phase 1 of ARCHITECTURE_PLAN.md. One interface, two interchangeable backends:
 *
 *   KB_STORE=files      JSON + a binary Float32Array sidecar on disk (default)
 *   KB_STORE=postgres   local Postgres + pgvector, schema-per-subject
 *
 * Nothing above this layer knows which is in use. `parity.test.js` runs the same
 * assertions against both — that suite is what keeps "files or Postgres" a real
 * choice instead of two implementations that quietly drift apart.
 *
 * ─── The canonical chunk ─────────────────────────────────────────────────────
 * Both drivers accept and return this shape. Drivers translate to their own
 * storage internally; callers never see driver-specific fields.
 *
 *   {
 *     id:          string   stable within a subject
 *     documentId:  string?  groups chunks belonging to one source document
 *     source:      string   filename, e.g. "plato-republic.txt"
 *     chunkIndex:  number   position within the source
 *     text:        string
 *     summary:     string
 *     difficulty:  string?
 *     concepts:    string[]
 *     themes:      string[]
 *     extras:      object   subject-specific fields (see plan §5)
 *     pdfPage:     number?  0-based position in the PDF   (vision ingest only)
 *     printedPage: string?  the label printed on the page (vision ingest only)
 *     embedding:   number[] | Float32Array | null
 *   }
 *
 * Search results add `score` (cosine similarity in [0,1], higher is closer) and
 * omit `embedding`.
 *
 * ─── Deferred to later phases ────────────────────────────────────────────────
 * getPage() and findSpecs() need the `pages` table, which only vision ingestion
 * populates — Phase 4. logChat()/incrementChunkQuery() are analytics — they no-op
 * in the files driver and are not part of the Phase 1 parity contract.
 */

import { createFilesStore } from './files.js';
import { createPostgresStore } from './postgres.js';
import { createAskCooterStore } from './askcooter.js';

export const DRIVERS = ['files', 'postgres', 'askcooter'];

/**
 * A subject slug becomes a directory name and a Postgres schema identifier, so
 * it is validated strictly at the boundary rather than escaped at each use.
 */
const SLUG_RE = /^[a-z][a-z0-9_]{0,62}$/;

export function assertValidSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid subject slug: ${JSON.stringify(slug)} — must match ${SLUG_RE} ` +
      `(lowercase, starts with a letter, letters/digits/underscore, max 63 chars)`,
    );
  }
  return slug;
}

/** Accepts Float32Array or number[]; returns a plain array, or null. */
export function toVectorArray(vec) {
  if (vec == null) return null;
  if (Array.isArray(vec)) return vec;
  if (ArrayBuffer.isView(vec)) return Array.from(vec);
  throw new Error('embedding must be an array, a typed array, or null');
}

/** Normalize a caller-supplied chunk to the canonical shape. */
export function normalizeChunk(chunk, i = 0) {
  if (!chunk || typeof chunk.text !== 'string') {
    throw new Error(`chunk[${i}] is missing required field: text`);
  }
  return {
    id:          String(chunk.id ?? `${chunk.source ?? 'doc'}::${chunk.chunkIndex ?? i}`),
    documentId:  chunk.documentId ?? null,
    source:      chunk.source ?? '(unknown)',
    chunkIndex:  Number.isInteger(chunk.chunkIndex) ? chunk.chunkIndex : i,
    text:        chunk.text,
    summary:     chunk.summary ?? '',
    difficulty:  chunk.difficulty ?? null,
    concepts:    Array.isArray(chunk.concepts) ? chunk.concepts : [],
    themes:      Array.isArray(chunk.themes) ? chunk.themes : [],
    extras:      chunk.extras && typeof chunk.extras === 'object' ? chunk.extras : {},
    pdfPage:     Number.isInteger(chunk.pdfPage) ? chunk.pdfPage : null,
    printedPage: chunk.printedPage ?? null,
    embedding:   toVectorArray(chunk.embedding ?? null),
  };
}

/**
 * Build a store. Options override env so tests can run both drivers in one process.
 *
 *   createStore()                                  -> KB_STORE, or 'files'
 *   createStore({ driver: 'files', root: '/tmp' })
 *   createStore({ driver: 'postgres', connectionString: '...' })
 */
export function createStore(opts = {}) {
  const driver = opts.driver || process.env.KB_STORE || 'files';
  switch (driver) {
    case 'files':    return createFilesStore(opts);
    case 'postgres': return createPostgresStore(opts);
    // Read-only adapter over an existing ask_cooter database (see askcooter.js).
    case 'askcooter': return createAskCooterStore(opts);
    default:
      throw new Error(`Unknown KB_STORE driver: ${driver} (expected one of ${DRIVERS.join(', ')})`);
  }
}

let _default = null;
/** Process-wide store, created on first use so .env is loaded first. */
export function getStore() {
  if (!_default) _default = createStore();
  return _default;
}
