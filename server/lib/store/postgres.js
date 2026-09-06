/**
 * store/postgres.js — local Postgres + pgvector.
 *
 * SCHEMA-PER-SUBJECT, one database. This is the structural decision from
 * ARCHITECTURE_PLAN.md §4.3 and it exists to solve a hard pgvector constraint:
 * a vector column has a FIXED dimension, and an index requires it. Pluggable
 * embedders mean subjects will differ (voyage-3.5 = 1024, nomic = 768,
 * MiniLM = 384), so one shared `chunks` table cannot hold them all.
 *
 *   public.sagestack_subjects   registry: slug -> dim, embed model
 *   public.sagestack_sessions   shared chat sessions
 *   "<slug>".chunks             per-subject, vector(<its own dim>) + HNSW
 *
 * DROP SCHEMA "<slug>" CASCADE deletes a subject cleanly and completely.
 *
 * Index choice: HNSW, not IVFFlat. IVFFlat needs representative data present
 * before the index can be built (which is why the IVFFlat line in
 * supabase-vector-search.sql is commented out and was never run); HNSW builds
 * fine on an empty table, so it can be created up front in initSubject.
 */

import pg from 'pg';
import { assertValidSlug, normalizeChunk, toVectorArray, summarizeSession } from './index.js';

/** pgvector's text input format. Cast the parameter as ::vector at every use. */
function toVectorLiteral(vec) {
  return '[' + Array.from(vec).join(',') + ']';
}

/** DB row (snake_case) -> canonical chunk (camelCase). */
function rowToChunk(r, { withEmbedding = false, withScore = false } = {}) {
  const c = {
    id:          r.id,
    documentId:  r.document_id,
    source:      r.source,
    chunkIndex:  r.chunk_index,
    text:        r.text,
    summary:     r.summary ?? '',
    difficulty:  r.difficulty,
    concepts:    r.concepts ?? [],
    themes:      r.themes ?? [],
    extras:      r.extras ?? {},
    pdfPage:     r.pdf_page,
    printedPage: r.printed_page,
  };
  if (withEmbedding) {
    // pgvector comes back as the text form "[a,b,c]".
    c.embedding = r.embedding == null ? null
      : (typeof r.embedding === 'string' ? JSON.parse(r.embedding) : Array.from(r.embedding));
  }
  if (withScore) c.score = Number(r.score);
  return c;
}

export function createPostgresStore(opts = {}) {
  const connectionString = opts.connectionString || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'postgres store requires a connection string.\n' +
      '  Set DATABASE_URL in server/.env, e.g.\n' +
      '    DATABASE_URL=postgresql://sage:sage@localhost:5433/sagestack\n' +
      '  Create the role and database first — see server/scripts/bootstrap-postgres.sql',
    );
  }

  const pool = new pg.Pool({ connectionString, max: opts.max ?? 4 });
  let ready = null;

  const q = (text, params) => pool.query(text, params);

  /** Verify pgvector is present and create the shared public tables. Once. */
  function ensureReady() {
    if (ready) return ready;
    ready = (async () => {
      const ext = await q(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
      if (ext.rowCount === 0) {
        throw new Error(
          'pgvector is not enabled in this database.\n' +
          '  A superuser must run:  CREATE EXTENSION vector;\n' +
          '  See server/scripts/bootstrap-postgres.sql',
        );
      }
      await q(`
        CREATE TABLE IF NOT EXISTS public.sagestack_subjects (
          slug        text PRIMARY KEY,
          name        text NOT NULL,
          dim         integer NOT NULL,
          embed_model text,
          created_at  timestamptz NOT NULL DEFAULT now(),
          updated_at  timestamptz,
          concept_map jsonb
        )`);
      await q(`
        CREATE TABLE IF NOT EXISTS public.sagestack_sessions (
          id         text PRIMARY KEY,
          messages   jsonb NOT NULL DEFAULT '[]'::jsonb,
          updated_at timestamptz NOT NULL DEFAULT now()
        )`);
      return true;
    })();
    return ready;
  }

  async function requireSubject(slug) {
    await ensureReady();
    assertValidSlug(slug);
    const r = await q(`SELECT * FROM public.sagestack_subjects WHERE slug = $1`, [slug]);
    if (r.rowCount === 0) throw new Error(`Unknown subject: ${slug} — call initSubject first`);
    return r.rows[0];
  }

  function metaFromRow(r) {
    return {
      slug: r.slug, name: r.name, dim: r.dim, embedModel: r.embed_model,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
      chunkCount: Number(r.chunk_count ?? 0),
      withEmbedding: Number(r.with_embedding ?? 0),
    };
  }

  /** Counts live in the chunk table, so metadata reads join against it. */
  async function metaWithCounts(slug) {
    const r = await q(`SELECT * FROM public.sagestack_subjects WHERE slug = $1`, [slug]);
    if (r.rowCount === 0) return null;
    const counts = await q(`
      SELECT count(*)::int AS chunk_count,
             count(embedding)::int AS with_embedding
      FROM "${slug}".chunks`);
    return metaFromRow({ ...r.rows[0], ...counts.rows[0] });
  }

  return {
    driver: 'postgres',

    // ─── Subjects ────────────────────────────────────────────────────────────

    async initSubject(slug, { dim, embedModel = null, name = null } = {}) {
      await ensureReady();
      assertValidSlug(slug);
      if (!Number.isInteger(dim) || dim <= 0) throw new Error('initSubject requires a positive integer dim');

      const existing = await q(`SELECT dim FROM public.sagestack_subjects WHERE slug = $1`, [slug]);
      if (existing.rowCount > 0) {
        if (existing.rows[0].dim !== dim) {
          throw new Error(
            `Subject "${slug}" already exists with dim ${existing.rows[0].dim}, refusing to reinit with dim ${dim}. ` +
            `Changing embedding dimension requires a full re-embed — drop the subject first.`,
          );
        }
        return metaWithCounts(slug);
      }

      // slug is validated above, so interpolating it as an identifier is safe;
      // it cannot be parameterised.
      await q(`CREATE SCHEMA IF NOT EXISTS "${slug}"`);
      await q(`
        CREATE TABLE IF NOT EXISTS "${slug}".chunks (
          ordinal      bigserial,
          id           text PRIMARY KEY,
          document_id  text,
          source       text NOT NULL,
          chunk_index  integer NOT NULL,
          text         text NOT NULL,
          summary      text NOT NULL DEFAULT '',
          difficulty   text,
          concepts     jsonb NOT NULL DEFAULT '[]'::jsonb,
          themes       jsonb NOT NULL DEFAULT '[]'::jsonb,
          extras       jsonb NOT NULL DEFAULT '{}'::jsonb,
          pdf_page     integer,
          printed_page text,
          embedding    vector(${dim}),
          created_at   timestamptz NOT NULL DEFAULT now()
        )`);
      await q(`CREATE INDEX IF NOT EXISTS chunks_source_idx ON "${slug}".chunks (source)`);
      await q(`CREATE INDEX IF NOT EXISTS chunks_ordinal_idx ON "${slug}".chunks (ordinal)`);
      // HNSW builds on an empty table; IVFFlat would not.
      await q(`CREATE INDEX IF NOT EXISTS chunks_embedding_idx
               ON "${slug}".chunks USING hnsw (embedding vector_cosine_ops)`);

      await q(`INSERT INTO public.sagestack_subjects (slug, name, dim, embed_model)
               VALUES ($1, $2, $3, $4)`, [slug, name || slug, dim, embedModel]);

      return metaWithCounts(slug);
    },

    async listSubjects() {
      await ensureReady();
      const r = await q(`SELECT slug FROM public.sagestack_subjects ORDER BY slug`);
      return Promise.all(r.rows.map(row => metaWithCounts(row.slug)));
    },

    async getSubjectMeta(slug) {
      await ensureReady();
      assertValidSlug(slug);
      try { return await metaWithCounts(slug); }
      catch { return null; }
    },

    async dropSubject(slug) {
      await ensureReady();
      assertValidSlug(slug);
      const r = await q(`DELETE FROM public.sagestack_subjects WHERE slug = $1`, [slug]);
      await q(`DROP SCHEMA IF EXISTS "${slug}" CASCADE`);
      return r.rowCount > 0;
    },

    // ─── Chunks ──────────────────────────────────────────────────────────────

    async upsertChunks(slug, input) {
      const subject = await requireSubject(slug);
      const dim = subject.dim;

      const incoming = input.map(normalizeChunk);
      for (const c of incoming) {
        if (c.embedding && c.embedding.length !== dim) {
          throw new Error(`chunk ${c.id}: embedding has ${c.embedding.length} dims, subject "${slug}" expects ${dim}`);
        }
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const c of incoming) {
          await client.query(
            `INSERT INTO "${slug}".chunks
               (id, document_id, source, chunk_index, text, summary, difficulty,
                concepts, themes, extras, pdf_page, printed_page, embedding)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13::vector)
             ON CONFLICT (id) DO UPDATE SET
               document_id  = EXCLUDED.document_id,
               source       = EXCLUDED.source,
               chunk_index  = EXCLUDED.chunk_index,
               text         = EXCLUDED.text,
               summary      = EXCLUDED.summary,
               difficulty   = EXCLUDED.difficulty,
               concepts     = EXCLUDED.concepts,
               themes       = EXCLUDED.themes,
               extras       = EXCLUDED.extras,
               pdf_page     = EXCLUDED.pdf_page,
               printed_page = EXCLUDED.printed_page,
               -- keep an existing embedding when the incoming chunk has none,
               -- matching the files driver's hasEmbedding behavior
               embedding    = COALESCE(EXCLUDED.embedding, "${slug}".chunks.embedding)`,
            [
              c.id, c.documentId, c.source, c.chunkIndex, c.text, c.summary, c.difficulty,
              JSON.stringify(c.concepts), JSON.stringify(c.themes), JSON.stringify(c.extras),
              c.pdfPage, c.printedPage,
              c.embedding ? toVectorLiteral(c.embedding) : null,
            ],
          );
        }
        await client.query(
          `UPDATE public.sagestack_subjects SET updated_at = now() WHERE slug = $1`, [slug]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      return incoming.length;
    },

    async getChunks(slug, { limit = null, offset = 0, withEmbeddings = false } = {}) {
      await requireSubject(slug);
      const cols = withEmbeddings ? '*, embedding::text AS embedding' : '*';
      const r = await q(
        `SELECT ${cols} FROM "${slug}".chunks ORDER BY ordinal
         LIMIT ${limit == null ? 'ALL' : '$1'} OFFSET ${limit == null ? '$1' : '$2'}`,
        limit == null ? [offset] : [limit, offset],
      );
      return r.rows.map(row => rowToChunk(row, { withEmbedding: withEmbeddings }));
    },

    async countChunks(slug) {
      await requireSubject(slug);
      const r = await q(`SELECT count(*)::int AS total, count(embedding)::int AS with_embedding
                         FROM "${slug}".chunks`);
      return { total: r.rows[0].total, withEmbedding: r.rows[0].with_embedding };
    },

    async chunksMissingEmbeddings(slug, { limit = null } = {}) {
      await requireSubject(slug);
      const r = await q(
        `SELECT id, text FROM "${slug}".chunks WHERE embedding IS NULL ORDER BY ordinal
         ${limit == null ? '' : 'LIMIT $1'}`,
        limit == null ? [] : [limit],
      );
      return r.rows.map(row => ({ id: row.id, text: row.text }));
    },

    async setEmbeddings(slug, updates) {
      const subject = await requireSubject(slug);
      const dim = subject.dim;

      const client = await pool.connect();
      let n = 0;
      try {
        await client.query('BEGIN');
        for (const { id, vector } of updates) {
          const vec = toVectorArray(vector);
          if (!vec) continue;
          if (vec.length !== dim) {
            throw new Error(`setEmbeddings ${id}: ${vec.length} dims, subject "${slug}" expects ${dim}`);
          }
          const r = await client.query(
            `UPDATE "${slug}".chunks SET embedding = $2::vector WHERE id = $1`,
            [String(id), toVectorLiteral(vec)],
          );
          n += r.rowCount;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return n;
    },

    // ─── Search ──────────────────────────────────────────────────────────────

    async searchByVector(slug, queryVector, topK = 10) {
      const subject = await requireSubject(slug);
      const dim = subject.dim;
      const vec = toVectorArray(queryVector);
      if (!vec || vec.length !== dim) {
        throw new Error(`searchByVector: query has ${vec ? vec.length : 0} dims, subject "${slug}" expects ${dim}`);
      }

      const r = await q(
        `SELECT *, 1 - (embedding <=> $1::vector) AS score
         FROM "${slug}".chunks
         WHERE embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [toVectorLiteral(vec), topK],
      );
      return r.rows.map(row => rowToChunk(row, { withScore: true }));
    },

    // ─── Concept map ─────────────────────────────────────────────────────────

    async saveConceptMap(slug, map) {
      await requireSubject(slug);
      await q(`UPDATE public.sagestack_subjects SET concept_map = $2::jsonb WHERE slug = $1`,
              [slug, JSON.stringify(map)]);
      return true;
    },

    async getConceptMap(slug) {
      await requireSubject(slug);
      const r = await q(`SELECT concept_map FROM public.sagestack_subjects WHERE slug = $1`, [slug]);
      return r.rows[0]?.concept_map ?? null;
    },

    // ─── Sessions ────────────────────────────────────────────────────────────

    async getSession(id) {
      await ensureReady();
      const r = await q(`SELECT messages FROM public.sagestack_sessions WHERE id = $1`, [String(id)]);
      return r.rowCount ? r.rows[0].messages : null;
    },

    async saveSession(id, messages) {
      await ensureReady();
      await q(
        `INSERT INTO public.sagestack_sessions (id, messages, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id) DO UPDATE SET messages = EXCLUDED.messages, updated_at = now()`,
        [String(id), JSON.stringify(messages)],
      );
      return true;
    },

    /** Every session belonging to one subject, newest first. */
    async listSessions(subject) {
      await ensureReady();
      assertValidSlug(subject);
      // The slug is validated to [a-z0-9_], so it cannot carry LIKE wildcards.
      const r = await q(
        `SELECT id, messages, updated_at FROM public.sagestack_sessions
         WHERE id LIKE $1 ORDER BY updated_at DESC`,
        [subject + '::%'],
      );
      return r.rows.map(row => summarizeSession({
        id: row.id,
        messages: row.messages,
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      }));
    },

    async deleteSession(id) {
      await ensureReady();
      const r = await q(`DELETE FROM public.sagestack_sessions WHERE id = $1`, [String(id)]);
      return r.rowCount > 0;
    },

    /** Remove chunks by id. */
    async deleteChunks(slug, ids) {
      await requireSubject(slug);
      if (!ids.length) return 0;
      const r = await q(`DELETE FROM "${slug}".chunks WHERE id = ANY($1::text[])`, [ids.map(String)]);
      return r.rowCount;
    },

    async close() { await pool.end(); },
  };
}
