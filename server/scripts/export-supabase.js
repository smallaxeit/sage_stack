#!/usr/bin/env node
/**
 * export-supabase.js  —  Phase 0 of ARCHITECTURE_PLAN.md
 *
 * Full rescue dump of the Supabase knowledge base before we migrate off it.
 * Unlike rebuild-cache-from-supabase.js (which deliberately skips `embedding`),
 * this pulls EVERYTHING — the vectors are the expensive part and currently exist
 * in exactly one place.
 *
 * Usage:
 *   npm run export:supabase
 *   node server/scripts/export-supabase.js --subject theology --out data/exports
 *
 * Writes to <out>/<subject>-<YYYY-MM-DD>/ :
 *
 *   raw/chunks-0000.json   verbatim API pages, zero transformation (the insurance policy)
 *   raw/concept_map.json   verbatim
 *   raw/<table>.json       sessions / chat_logs / chunk_analytics, if present
 *
 *   chunks.jsonl           one chunk per line, metadata only, no vectors
 *   vectors.f32            raw Float32Array, dim * N, row-major, aligned to chunks.jsonl
 *   manifest.json          dim, counts, model, checksums — the files-driver manifest
 *
 * The derived trio is exactly the `files` store-driver layout from the plan, so
 * this export drops straight in as subject #1. `raw/` exists so a bug in the
 * transform can never cost us the rescue.
 */

import fs from 'fs/promises';
import { createWriteStream, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../..');

// ─── .env ─────────────────────────────────────────────────────────────────────
// Same manual loader as build-knowledge.js — reliable in ESM regardless of cwd.
try {
  const lines = readFileSync(path.join(__dirname, '../.env'), 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key) process.env[key] = trimmed.slice(eq + 1).trim();
  }
} catch { /* rely on existing process.env */ }

// ─── Args ─────────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SUBJECT   = arg('subject', 'theology');
const OUT_BASE  = path.resolve(REPO_ROOT, arg('out', 'data/exports'));
const PAGE_SIZE = Number(arg('page-size', 200)); // small: 1000 rows x 1024 floats is a huge payload

// ─── Preflight ────────────────────────────────────────────────────────────────

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(`
Missing Supabase credentials.

  Create server/.env containing at least:

    SUPABASE_URL=https://<your-project>.supabase.co
    SUPABASE_SERVICE_KEY=<service_role key, not anon>

  The service_role key is required — the anon key cannot read every row.
  Find both at: Supabase dashboard -> Project Settings -> API
`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── Embedding parsing ────────────────────────────────────────────────────────

/**
 * PostgREST serializes pgvector as a string ("[0.1,0.2,...]"), but returns a
 * real array under some client/column configurations. Handle both, and never
 * throw — a malformed vector is counted and reported, not fatal.
 */
function parseEmbedding(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s.startsWith('[')) return null;
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }
  return null;
}

// ─── Paged fetch ──────────────────────────────────────────────────────────────

/**
 * Ordered pagination. The existing rebuild-cache script pages without an
 * ORDER BY, which Postgres does not guarantee to be stable across requests —
 * rows can repeat or vanish between pages. Ordering by a unique key fixes it.
 */
async function fetchAllPages(table, { columns = '*', orderBy = 'id', pageSize = PAGE_SIZE, onPage } = {}) {
  const pages = [];
  let from = 0;
  let total = 0;

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order(orderBy, { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data || data.length === 0) break;

    pages.push(data);
    total += data.length;
    if (onPage) await onPage(data, pages.length - 1);
    process.stdout.write(`  ${table}: ${total} rows\r`);

    if (data.length < pageSize) break;
    from += pageSize;
  }

  process.stdout.write(`  ${table}: ${total} rows\n`);
  return { pages, total };
}

/** Best-effort dump of a table that may not exist (analytics SQL is optional). */
async function tryDumpTable(table, outDir, orderBy = 'id') {
  try {
    const { pages, total } = await fetchAllPages(table, { orderBy });
    const rows = pages.flat();
    await fs.writeFile(path.join(outDir, `${table}.json`), JSON.stringify(rows, null, 2));
    return { table, rows: total, ok: true };
  } catch (err) {
    console.log(`  ${table}: skipped (${err.message})`);
    return { table, rows: 0, ok: false, reason: err.message };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.join(OUT_BASE, `${SUBJECT}-${stamp}`);
  const rawDir = path.join(outDir, 'raw');

  // Never silently clobber a previous rescue.
  try {
    await fs.access(outDir);
    console.error(`\nRefusing to overwrite an existing export:\n  ${outDir}\n\nMove or delete it, or pass --out somewhere else.`);
    process.exit(1);
  } catch { /* does not exist — good */ }

  await fs.mkdir(rawDir, { recursive: true });

  console.log(`\nExporting "${SUBJECT}" from ${SUPABASE_URL}`);
  console.log(`  -> ${outDir}\n`);

  // --- Expected row count, so we can prove we got everything -----------------
  const { count: expectedChunks, error: countErr } = await supabase
    .from('chunks').select('id', { count: 'exact', head: true });
  if (countErr) throw new Error(`count chunks: ${countErr.message}`);
  console.log(`  chunks table reports ${expectedChunks} rows\n`);

  // --- Chunks + embeddings ---------------------------------------------------
  const chunkStream  = createWriteStream(path.join(outDir, 'chunks.jsonl'));
  const vectorStream = createWriteStream(path.join(outDir, 'vectors.f32'));

  let dim = null;
  let withEmbedding = 0;
  let withoutEmbedding = 0;
  let malformed = 0;
  let dimMismatch = 0;
  let ordinal = 0;

  const { total: chunkCount } = await fetchAllPages('chunks', {
    columns: '*',
    orderBy: 'id',
    onPage: async (rows, pageIdx) => {
      // 1. Verbatim archive first — before any transformation can go wrong.
      await fs.writeFile(
        path.join(rawDir, `chunks-${String(pageIdx).padStart(4, '0')}.json`),
        JSON.stringify(rows, null, 2),
      );

      // 2. Derived files-driver layout.
      for (const row of rows) {
        const { embedding, ...meta } = row;
        const vec = parseEmbedding(embedding);

        if (vec === null) {
          if (embedding == null) withoutEmbedding++; else malformed++;
        } else {
          if (dim === null) dim = vec.length;
          if (vec.length !== dim) {
            dimMismatch++;
          } else {
            const buf = Buffer.allocUnsafe(dim * 4);
            for (let i = 0; i < dim; i++) buf.writeFloatLE(vec[i], i * 4);
            vectorStream.write(buf);
            withEmbedding++;
          }
        }

        // `vectorRow` is the row index into vectors.f32, or null when absent.
        chunkStream.write(JSON.stringify({
          ...meta,
          ordinal,
          vectorRow: vec !== null && vec.length === dim ? withEmbedding - 1 : null,
        }) + '\n');
        ordinal++;
      }
    },
  });

  await new Promise(r => chunkStream.end(r));
  await new Promise(r => vectorStream.end(r));

  // --- Concept map -----------------------------------------------------------
  console.log('');
  const { data: conceptMap, error: cmErr } = await supabase.from('concept_map').select('*');
  if (cmErr) {
    console.log(`  concept_map: skipped (${cmErr.message})`);
  } else {
    await fs.writeFile(path.join(rawDir, 'concept_map.json'), JSON.stringify(conceptMap, null, 2));
    console.log(`  concept_map: ${conceptMap?.length || 0} rows`);
  }

  // --- Everything else (optional tables) -------------------------------------
  const extras = [];
  for (const t of ['sessions', 'chat_logs', 'chunk_analytics']) {
    extras.push(await tryDumpTable(t, rawDir, t === 'sessions' ? 'id' : 'id'));
  }

  // --- Manifest --------------------------------------------------------------
  const sources = {};
  // Cheap second pass over the JSONL we just wrote, to summarize per-source counts.
  const jsonl = await fs.readFile(path.join(outDir, 'chunks.jsonl'), 'utf8');
  for (const line of jsonl.split('\n')) {
    if (!line) continue;
    const src = JSON.parse(line).source || '(unknown)';
    sources[src] = (sources[src] || 0) + 1;
  }

  const manifest = {
    subject: SUBJECT,
    exportedAt: new Date().toISOString(),
    origin: { type: 'supabase', url: SUPABASE_URL },
    embed: {
      // Recorded from what we actually found, not assumed. NOTE: the running
      // build used voyage-3; ARCHITECTURE_PLAN.md standardizes on voyage-3.5,
      // which is a re-embed, not a swap. These vectors are voyage-3.
      model: 'voyage-3',
      dim,
    },
    counts: {
      expectedChunks,
      exportedChunks: chunkCount,
      withEmbedding,
      withoutEmbedding,
      malformed,
      dimMismatch,
      conceptMapRows: conceptMap?.length || 0,
    },
    sources,
    files: {
      chunks: 'chunks.jsonl',
      vectors: 'vectors.f32',
      raw: 'raw/',
    },
    extras: extras.filter(e => e.ok).map(e => ({ table: e.table, rows: e.rows })),
  };
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // --- Verification ----------------------------------------------------------
  console.log('\n─── Verification ───────────────────────────────');

  const problems = [];
  const note = (ok, msg) => console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);

  const countOk = chunkCount === expectedChunks;
  note(countOk, `row count: exported ${chunkCount} / reported ${expectedChunks}`);
  if (!countOk) problems.push('exported row count does not match the table count');

  note(true, `embeddings: ${withEmbedding} present, ${withoutEmbedding} null`);
  if (malformed)    { note(false, `${malformed} embeddings failed to parse`); problems.push('malformed embeddings'); }
  if (dimMismatch)  { note(false, `${dimMismatch} embeddings had an unexpected dimension`); problems.push('dimension mismatch'); }

  const dimOk = dim !== null;
  note(dimOk, `dimension: ${dim ?? 'NONE FOUND'}`);
  if (!dimOk) problems.push('no embeddings found at all');

  // Byte-level check that vectors.f32 is exactly the size it should be.
  if (dimOk) {
    const { size } = await fs.stat(path.join(outDir, 'vectors.f32'));
    const expectedBytes = withEmbedding * dim * 4;
    const sizeOk = size === expectedBytes;
    note(sizeOk, `vectors.f32: ${size} bytes (expected ${expectedBytes})`);
    if (!sizeOk) problems.push('vectors.f32 is the wrong size');

    // Spot-check the first vector round-tripped through the binary file.
    // Read with readFloatLE rather than a Float32Array view: allocUnsafe draws
    // from a shared pool whose byteOffset is not guaranteed 4-byte aligned, and
    // a misaligned typed-array view throws (dim 384/768 land in the pool; 1024
    // does not — so the bug would only appear on a local embedder).
    const fh = await fs.open(path.join(outDir, 'vectors.f32'), 'r');
    const buf = Buffer.alloc(dim * 4);
    await fh.read(buf, 0, dim * 4, 0);
    await fh.close();
    let sumSq = 0;
    for (let i = 0; i < dim; i++) { const v = buf.readFloatLE(i * 4); sumSq += v * v; }
    const norm = Math.sqrt(sumSq);
    const normOk = Number.isFinite(norm) && norm > 0;
    note(normOk, `first vector L2 norm: ${norm.toFixed(6)}`);
    if (!normOk) problems.push('first vector is degenerate (all zeros or NaN)');
  }

  console.log('────────────────────────────────────────────────');
  console.log(`\nSources exported (${Object.keys(sources).length}):`);
  for (const [src, n] of Object.entries(sources).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${src}`);
  }

  console.log(`\n-> ${outDir}`);

  if (problems.length) {
    console.error(`\nExport completed WITH PROBLEMS:\n${problems.map(p => `  - ${p}`).join('\n')}`);
    console.error('\nraw/ holds the verbatim API responses — the rescue itself is intact.');
    process.exit(2);
  }
  console.log('\nExport verified clean.');
}

main().catch(err => {
  console.error('\nExport failed:', err.message);
  process.exit(1);
});
