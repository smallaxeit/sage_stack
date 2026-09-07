/**
 * store/askcooter.js — READ-ONLY adapter over an existing ask_cooter database.
 *
 * ask_cooter already holds a fully built corpus: vision-extracted pages, their
 * chunks, and Voyage embeddings that cost real money to produce. Copying that
 * into SageStack's own schema would duplicate it and let the two drift, so this
 * connects to it in place and translates its shape into the canonical chunk on
 * the way out.
 *
 * Its schema (see ask_cooter/askcooter/schema.sql):
 *
 *   pages(id, pdf_page, printed_page, section, component_tags[], image_path,
 *         markdown, specs jsonb, diagrams jsonb)
 *   chunks(id, page_id -> pages.id, pdf_page, chunk_index, content,
 *          embedding vector(1024), token_count)
 *
 * Differences that the mapping has to absorb:
 *
 *   - chunk_index is per PAGE, not per document, so it is not a stable global
 *     ordinal. chunks.id is used for ordering and identity instead.
 *   - there is no summary/concepts/themes — ask_cooter never ran that stage.
 *     component_tags is the closest thing to concepts, so it is mapped there.
 *   - specs and diagrams are page-level, and land in the chunk's `extras`,
 *     which is exactly what the per-subject extract block was designed for.
 *   - one PDF per database, and its filename is not stored, so the subject
 *     profile supplies `sourceName`.
 *
 * EVERY WRITE THROWS. This is someone else's working database; the failure mode
 * for a silent no-op write is a subject that looks like it accepted an upload
 * and did not.
 */

import pg from 'pg';
import { toVectorArray } from './index.js';

function toVectorLiteral(vec) {
  return '[' + Array.from(vec).join(',') + ']';
}

const readOnly = (op) => () => {
  throw new Error(
    `askcooter store is read-only — "${op}" is not supported. ` +
    `This subject connects to an existing ask_cooter database; ingest into a ` +
    `SageStack-owned subject instead.`,
  );
};

export function createAskCooterStore(opts = {}) {
  const connectionString = opts.connectionString || process.env.ASKCOOTER_DATABASE_URL;
  if (!connectionString) {
    throw new Error('askcooter store requires a connectionString in the subject profile store block');
  }

  const sourceName  = opts.sourceName || 'manual.pdf';
  const embedModel  = opts.embedModel || 'voyage-3.5';
  const dim         = opts.dim ?? 1024;
  const displayName = opts.name || 'ask_cooter corpus';

  const pool = new pg.Pool({ connectionString, max: opts.max ?? 2 });
  const q = (text, params) => pool.query(text, params);

  /** ask_cooter row -> canonical chunk. */
  const toChunk = (r, { withScore = false, withEmbedding = false } = {}) => {
    const c = {
      id:          String(r.id),
      documentId:  sourceName,
      source:      sourceName,
      chunkIndex:  Number(r.ordinal ?? r.id),
      text:        r.content,
      summary:     '',
      difficulty:  null,
      // ask_cooter has no concept extraction; component tags are the nearest
      // equivalent and are what the UI can usefully show.
      concepts:    r.component_tags || [],
      themes:      r.section ? [r.section] : [],
      extras: {
        section:       r.section ?? null,
        specs:         r.specs ?? [],
        diagrams:      r.diagrams ?? [],
        componentTags: r.component_tags || [],
      },
      pdfPage:     r.pdf_page,
      printedPage: r.printed_page ?? null,
    };
    if (withEmbedding) {
      c.embedding = r.embedding == null ? null
        : (typeof r.embedding === 'string' ? JSON.parse(r.embedding) : Array.from(r.embedding));
    }
    if (withScore) c.score = Number(r.score);
    return c;
  };

  const SELECT = `
    SELECT c.id,
           row_number() OVER (ORDER BY c.id) - 1 AS ordinal,
           c.pdf_page, c.content,
           p.printed_page, p.section, p.component_tags, p.specs, p.diagrams`;
  const FROM = ` FROM chunks c JOIN pages p ON p.id = c.page_id`;

  return {
    driver: 'askcooter',
    readOnly: true,

    async getSubjectMeta(slug) {
      const r = await q(`SELECT count(*)::int total, count(embedding)::int embedded FROM chunks`);
      return {
        slug,
        name: displayName,
        dim,
        embedModel,
        chunkCount: r.rows[0].total,
        withEmbedding: r.rows[0].embedded,
        createdAt: null,
        updatedAt: null,
        readOnly: true,
      };
    },

    async listSubjects() { return []; },   // this store backs exactly one subject

    async countChunks() {
      const r = await q(`SELECT count(*)::int total, count(embedding)::int embedded FROM chunks`);
      return { total: r.rows[0].total, withEmbedding: r.rows[0].embedded };
    },

    async getChunks(slug, { limit = null, offset = 0, withEmbeddings = false } = {}) {
      const cols = withEmbeddings ? `${SELECT}, c.embedding::text AS embedding` : SELECT;
      const r = await q(
        `${cols}${FROM} ORDER BY c.id
         LIMIT ${limit == null ? 'ALL' : '$1'} OFFSET ${limit == null ? '$1' : '$2'}`,
        limit == null ? [offset] : [limit, offset],
      );
      return r.rows.map(row => toChunk(row, { withEmbedding: withEmbeddings }));
    },

    async chunksMissingEmbeddings() { return []; },   // fully embedded by construction

    async searchByVector(slug, queryVector, topK = 10) {
      const vec = toVectorArray(queryVector);
      if (!vec || vec.length !== dim) {
        throw new Error(`searchByVector: query has ${vec ? vec.length : 0} dims, this corpus is ${dim}`);
      }
      // The parameter must be cast to `vector` explicitly: node-postgres sends a
      // JS array as float8[], and the <=> operator has no implicit cast from it.
      const r = await q(
        `${SELECT}, 1 - (c.embedding <=> $1::vector) AS score
         ${FROM}
         WHERE c.embedding IS NOT NULL
         ORDER BY c.embedding <=> $1::vector
         LIMIT $2`,
        [toVectorLiteral(vec), topK],
      );
      return r.rows.map(row => toChunk(row, { withScore: true }));
    },

    /** Page-level detail, for the viewer. */
    async getPage(slug, pdfPage) {
      const r = await q(
        `SELECT pdf_page, printed_page, section, markdown, specs, diagrams, image_path
         FROM pages WHERE pdf_page = $1`,
        [pdfPage],
      );
      if (r.rowCount === 0) return null;
      const p = r.rows[0];
      return {
        pdfPage: p.pdf_page,
        printedPage: p.printed_page,
        section: p.section,
        markdown: p.markdown,
        specs: p.specs ?? [],
        diagrams: p.diagrams ?? [],
        imagePath: p.image_path,
      };
    },

    /** A lightweight table of contents. */
    async listSections() {
      const r = await q(
        `SELECT section, min(pdf_page) AS first_page, max(pdf_page) AS last_page, count(*)::int pages
         FROM pages WHERE section IS NOT NULL AND section <> ''
         GROUP BY section ORDER BY first_page`,
      );
      return r.rows.map(x => ({
        section: x.section, firstPage: x.first_page, lastPage: x.last_page, pages: x.pages,
      }));
    },

    async getConceptMap() { return null; },

    // A borrowed database has nowhere to put our settings, and pretending to
    // save them would lose a user's selection silently.
    async listExtraValues(slug, key) {
      const r = await q(`SELECT p.${key === 'componentTags' ? 'component_tags' : 'specs'} AS v FROM pages p`)
        .catch(() => ({ rows: [] }));
      return r.rows.map(x => x.v).filter(v => v != null);
    },

    async getSettings() { return {}; },
    saveSettings: readOnly('saveSettings'),

    // ─── Writes are refused, loudly ──────────────────────────────────────────
    initSubject:   async (slug, { dim: d } = {}) => {
      // Tolerated as a no-op ONLY when it matches, so ingest-time guards that
      // call initSubject before writing still fail on the write, not here.
      if (d != null && d !== dim) {
        throw new Error(`askcooter corpus is ${dim}-dim; subject asked for ${d}`);
      }
      return { slug, name: displayName, dim, embedModel, readOnly: true };
    },
    upsertChunks:    readOnly('upsertChunks'),
    setEmbeddings:   readOnly('setEmbeddings'),
    deleteChunks:    readOnly('deleteChunks'),
    dropSubject:     readOnly('dropSubject'),
    saveConceptMap:  readOnly('saveConceptMap'),

    // Sessions never belong in a borrowed database.
    getSession:    async () => null,
    listSessions:  async () => [],
    saveSession:   readOnly('saveSession'),
    deleteSession: readOnly('deleteSession'),

    async close() { await pool.end(); },
  };
}
