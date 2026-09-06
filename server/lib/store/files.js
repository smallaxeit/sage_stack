/**
 * store/files.js — zero-dependency local store.
 *
 * Layout, per subject, under <root>/<slug>/ :
 *
 *   manifest.json     dim, embed model, counts, timestamps
 *   chunks.jsonl      one chunk per line, metadata only
 *   vectors.f32       raw little-endian Float32, dim * N, row-major
 *   concept-map.json  optional
 *
 * The layout is DENSE: line N of chunks.jsonl owns row N of vectors.f32, always.
 * Chunks with no embedding still occupy a zero-filled row and carry
 * hasEmbedding:false. That costs dim*4 bytes per un-embedded chunk and buys
 * O(1) writes when embeddings arrive later, instead of reflowing the whole file.
 *
 * (The Phase 0 Supabase export writes a SPARSE variant — it records `vectorRow`
 * per chunk because it is reporting what Supabase actually held. The Phase 2
 * importer maps sparse -> dense.)
 *
 * Why a binary sidecar at all: 10k chunks x 1024 dims as JSON numbers is ~80 MB
 * to parse on every boot; as Float32 it is a 40 MB readFile straight into a
 * typed array. Brute-force cosine over that is a few milliseconds.
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { assertValidSlug, normalizeChunk, toVectorArray, summarizeSession } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../../..');

export function createFilesStore(opts = {}) {
  const root        = path.resolve(opts.root || process.env.KB_FILES_ROOT || path.join(REPO_ROOT, 'data/subjects'));
  const sessionsDir = path.resolve(opts.sessionsRoot || path.join(root, '..', 'sessions'));
  const cache       = new Map(); // slug -> { meta, chunks, vectors, norms, index }

  const subjectDir = (slug) => path.join(root, assertValidSlug(slug));
  const p = (slug, file) => path.join(subjectDir(slug), file);

  async function exists(f) {
    try { await fs.access(f); return true; } catch { return false; }
  }

  function rowNorm(vectors, row, dim) {
    let s = 0;
    const off = row * dim;
    for (let i = 0; i < dim; i++) { const v = vectors[off + i]; s += v * v; }
    return Math.sqrt(s);
  }

  // ─── Load / persist ────────────────────────────────────────────────────────

  async function load(slug) {
    if (cache.has(slug)) return cache.get(slug);

    const manifestPath = p(slug, 'manifest.json');
    if (!await exists(manifestPath)) return null;

    const meta = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const dim  = meta.dim;

    let chunks = [];
    if (await exists(p(slug, 'chunks.jsonl'))) {
      const raw = await fs.readFile(p(slug, 'chunks.jsonl'), 'utf8');
      chunks = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
    }

    const vectors = new Float32Array(chunks.length * dim);
    if (await exists(p(slug, 'vectors.f32'))) {
      const buf = await fs.readFile(p(slug, 'vectors.f32'));
      // Copy rather than view: a Buffer's byteOffset is not guaranteed 4-byte
      // aligned (it is drawn from a shared pool) and a misaligned Float32Array
      // view throws. Copying is O(n) once per load and always correct.
      const n = Math.min(vectors.length, Math.floor(buf.length / 4));
      for (let i = 0; i < n; i++) vectors[i] = buf.readFloatLE(i * 4);
    }

    const norms = new Float64Array(chunks.length);
    for (let i = 0; i < chunks.length; i++) norms[i] = rowNorm(vectors, i, dim);

    const state = { meta, chunks, vectors, norms, index: new Map(chunks.map((c, i) => [c.id, i])) };
    cache.set(slug, state);
    return state;
  }

  async function persist(slug, state) {
    await fs.mkdir(subjectDir(slug), { recursive: true });

    state.meta.chunkCount    = state.chunks.length;
    state.meta.withEmbedding = state.chunks.reduce((n, c) => n + (c.hasEmbedding ? 1 : 0), 0);
    state.meta.updatedAt     = new Date().toISOString();

    const jsonl = state.chunks.map(c => JSON.stringify(c)).join('\n');
    await fs.writeFile(p(slug, 'chunks.jsonl'), state.chunks.length ? jsonl + '\n' : '');

    const buf = Buffer.allocUnsafe(state.vectors.length * 4);
    for (let i = 0; i < state.vectors.length; i++) buf.writeFloatLE(state.vectors[i], i * 4);
    await fs.writeFile(p(slug, 'vectors.f32'), buf);

    await fs.writeFile(p(slug, 'manifest.json'), JSON.stringify(state.meta, null, 2));
  }

  /** Grow the dense vector block to hold `n` rows, preserving existing data. */
  function ensureRows(state, n) {
    const dim = state.meta.dim;
    if (state.vectors.length >= n * dim) return;
    const grown = new Float32Array(n * dim);
    grown.set(state.vectors);
    state.vectors = grown;
    const norms = new Float64Array(n);
    norms.set(state.norms);
    state.norms = norms;
  }

  return {
    driver: 'files',

    // ─── Subjects ────────────────────────────────────────────────────────────

    async initSubject(slug, { dim, embedModel = null, name = null } = {}) {
      assertValidSlug(slug);
      if (!Number.isInteger(dim) || dim <= 0) throw new Error('initSubject requires a positive integer dim');

      const existing = await load(slug);
      if (existing) {
        if (existing.meta.dim !== dim) {
          throw new Error(
            `Subject "${slug}" already exists with dim ${existing.meta.dim}, refusing to reinit with dim ${dim}. ` +
            `Changing embedding dimension requires a full re-embed — drop the subject first.`,
          );
        }
        return existing.meta;
      }

      const meta = {
        slug, name: name || slug, dim, embedModel,
        createdAt: new Date().toISOString(), updatedAt: null,
        chunkCount: 0, withEmbedding: 0,
      };
      const state = { meta, chunks: [], vectors: new Float32Array(0), norms: new Float64Array(0), index: new Map() };
      cache.set(slug, state);
      await persist(slug, state);
      return meta;
    },

    async listSubjects() {
      if (!await exists(root)) return [];
      const out = [];
      for (const e of await fs.readdir(root, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        try { out.push(JSON.parse(await fs.readFile(path.join(root, e.name, 'manifest.json'), 'utf8'))); }
        catch { /* not a subject dir */ }
      }
      return out.sort((a, b) => a.slug.localeCompare(b.slug));
    },

    async getSubjectMeta(slug) {
      const s = await load(slug);
      return s ? s.meta : null;
    },

    async dropSubject(slug) {
      const dir = subjectDir(slug);
      if (!await exists(dir)) return false;
      await fs.rm(dir, { recursive: true, force: true });
      cache.delete(slug);
      return true;
    },

    // ─── Chunks ──────────────────────────────────────────────────────────────

    async upsertChunks(slug, input) {
      const state = await load(slug);
      if (!state) throw new Error(`Unknown subject: ${slug} — call initSubject first`);
      const dim = state.meta.dim;

      const incoming = input.map(normalizeChunk);
      for (const c of incoming) {
        if (c.embedding && c.embedding.length !== dim) {
          throw new Error(`chunk ${c.id}: embedding has ${c.embedding.length} dims, subject "${slug}" expects ${dim}`);
        }
      }

      for (const c of incoming) {
        const { embedding, ...meta } = c;
        let row = state.index.get(c.id);

        if (row === undefined) {
          row = state.chunks.length;
          state.index.set(c.id, row);
          state.chunks.push({ ...meta, hasEmbedding: false });
          ensureRows(state, state.chunks.length);
        } else {
          state.chunks[row] = { ...meta, hasEmbedding: state.chunks[row].hasEmbedding };
        }

        if (embedding) {
          state.vectors.set(embedding, row * dim);
          state.norms[row] = rowNorm(state.vectors, row, dim);
          state.chunks[row].hasEmbedding = true;
        }
      }

      await persist(slug, state);
      return incoming.length;
    },

    async getChunks(slug, { limit = null, offset = 0, withEmbeddings = false } = {}) {
      const state = await load(slug);
      if (!state) return [];
      const dim = state.meta.dim;
      const end = limit == null ? state.chunks.length : Math.min(state.chunks.length, offset + limit);

      const out = [];
      for (let i = offset; i < end; i++) {
        const { hasEmbedding, ...c } = state.chunks[i];
        out.push(withEmbeddings
          ? { ...c, embedding: hasEmbedding ? Array.from(state.vectors.subarray(i * dim, (i + 1) * dim)) : null }
          : c);
      }
      return out;
    },

    async countChunks(slug) {
      const state = await load(slug);
      if (!state) return { total: 0, withEmbedding: 0 };
      return {
        total: state.chunks.length,
        withEmbedding: state.chunks.reduce((n, c) => n + (c.hasEmbedding ? 1 : 0), 0),
      };
    },

    async chunksMissingEmbeddings(slug, { limit = null } = {}) {
      const state = await load(slug);
      if (!state) return [];
      const out = [];
      for (const c of state.chunks) {
        if (c.hasEmbedding) continue;
        out.push({ id: c.id, text: c.text });
        if (limit != null && out.length >= limit) break;
      }
      return out;
    },

    async setEmbeddings(slug, updates) {
      const state = await load(slug);
      if (!state) throw new Error(`Unknown subject: ${slug}`);
      const dim = state.meta.dim;

      let n = 0;
      for (const { id, vector } of updates) {
        const row = state.index.get(String(id));
        if (row === undefined) continue;
        const vec = toVectorArray(vector);
        if (!vec) continue;
        if (vec.length !== dim) {
          throw new Error(`setEmbeddings ${id}: ${vec.length} dims, subject "${slug}" expects ${dim}`);
        }
        state.vectors.set(vec, row * dim);
        state.norms[row] = rowNorm(state.vectors, row, dim);
        state.chunks[row].hasEmbedding = true;
        n++;
      }

      await persist(slug, state);
      return n;
    },

    // ─── Search ──────────────────────────────────────────────────────────────

    async searchByVector(slug, queryVector, topK = 10) {
      const state = await load(slug);
      if (!state || state.chunks.length === 0) return [];

      const dim = state.meta.dim;
      const q = toVectorArray(queryVector);
      if (!q || q.length !== dim) {
        throw new Error(`searchByVector: query has ${q ? q.length : 0} dims, subject "${slug}" expects ${dim}`);
      }

      let qNorm = 0;
      for (let i = 0; i < dim; i++) qNorm += q[i] * q[i];
      qNorm = Math.sqrt(qNorm);
      if (qNorm === 0) return [];

      const scored = [];
      for (let row = 0; row < state.chunks.length; row++) {
        if (!state.chunks[row].hasEmbedding || state.norms[row] === 0) continue;
        let dot = 0;
        const off = row * dim;
        for (let i = 0; i < dim; i++) dot += q[i] * state.vectors[off + i];
        scored.push({ row, score: dot / (qNorm * state.norms[row]) });
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, topK).map(({ row, score }) => {
        const { hasEmbedding, ...c } = state.chunks[row];
        return { ...c, score };
      });
    },

    // ─── Concept map ─────────────────────────────────────────────────────────

    async saveConceptMap(slug, map) {
      await fs.mkdir(subjectDir(slug), { recursive: true });
      await fs.writeFile(p(slug, 'concept-map.json'), JSON.stringify(map, null, 2));
      return true;
    },

    async getConceptMap(slug) {
      try { return JSON.parse(await fs.readFile(p(slug, 'concept-map.json'), 'utf8')); }
      catch { return null; }
    },

    // ─── Sessions ────────────────────────────────────────────────────────────
    // Session ids come from the client, so they are hashed rather than used as
    // filenames directly — "../../etc" must never become a path.

    async getSession(id) {
      try { return JSON.parse(await fs.readFile(sessionFile(id), 'utf8')).messages; }
      catch { return null; }
    },

    async saveSession(id, messages) {
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(sessionFile(id), JSON.stringify({ id: String(id), messages, updatedAt: new Date().toISOString() }));
      return true;
    },

    /**
     * Every session belonging to one subject, newest first.
     *
     * Filenames are sha1 hashes of the key, so the subject cannot be recovered
     * from the name — the key is stored inside each file and filtered on read.
     * Fine at this scale; if session counts ever grow, this wants an index.
     */
    async listSessions(subject) {
      assertValidSlug(subject);
      const prefix = subject + '::';
      let names = [];
      try { names = await fs.readdir(sessionsDir); } catch { return []; }

      const out = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(await fs.readFile(path.join(sessionsDir, name), 'utf8'));
          if (typeof rec.id !== 'string' || !rec.id.startsWith(prefix)) continue;
          out.push(summarizeSession(rec));
        } catch { /* unreadable or partial write — skip */ }
      }
      return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },

    async deleteSession(id) {
      try { await fs.unlink(sessionFile(id)); return true; } catch { return false; }
    },

    /**
     * Remove chunks by id. The dense layout means surviving rows must be
     * compacted and reindexed, so this rebuilds the vector block rather than
     * leaving holes that would silently shift every later chunk row.
     */
    async deleteChunks(slug, ids) {
      const state = await load(slug);
      if (!state) return 0;
      const dim = state.meta.dim;
      const doomed = new Set(ids.map(String));
      if (doomed.size === 0) return 0;

      const keep = [];
      for (let i = 0; i < state.chunks.length; i++) {
        if (!doomed.has(state.chunks[i].id)) keep.push(i);
      }
      const removed = state.chunks.length - keep.length;
      if (removed === 0) return 0;

      const vectors = new Float32Array(keep.length * dim);
      const norms = new Float64Array(keep.length);
      keep.forEach((oldRow, newRow) => {
        vectors.set(state.vectors.subarray(oldRow * dim, (oldRow + 1) * dim), newRow * dim);
        norms[newRow] = state.norms[oldRow];
      });

      state.chunks = keep.map(i => state.chunks[i]);
      state.vectors = vectors;
      state.norms = norms;
      state.index = new Map(state.chunks.map((c, i) => [c.id, i]));

      await persist(slug, state);
      return removed;
    },

    async close() { cache.clear(); },
  };

  function sessionFile(id) {
    return path.join(sessionsDir, crypto.createHash('sha1').update(String(id)).digest('hex') + '.json');
  }
}
