#!/usr/bin/env node
/**
 * import-export.js — load a Phase 0 export into a subject.
 *
 *   node server/scripts/import-export.js --dir data/exports/theology-2026-09-06
 *   node server/scripts/import-export.js --dir <dir> --subject theology --dry-run
 *
 * Reads the chunks.jsonl + vectors.f32 pair written by export-supabase.js and
 * upserts it into whichever store the subject is configured for. The embeddings
 * come across as-is: they cost real money to produce and re-embedding would
 * both spend that again and change the vectors.
 *
 * Two shape differences it has to reconcile:
 *
 *   SPARSE -> DENSE   the export records a `vectorRow` per chunk because it is
 *                     reporting what Supabase actually held; a chunk with no
 *                     embedding has vectorRow null. Nothing here assumes row N
 *                     of the file belongs to line N of the JSONL.
 *
 *   snake -> canonical  Supabase columns are snake_case and theology-specific
 *                     (scripture_refs, philosophical_arguments). The generic
 *                     core maps to canonical fields and the rest lands in
 *                     `extras`, which is what the per-subject extract block
 *                     was designed for.
 *
 * The embedding MODEL is carried from the manifest into the subject metadata,
 * and checked against the subject profile. voyage-3 and voyage-3.5 are both
 * 1024-dim, so a dimension check alone cannot tell them apart — and querying
 * voyage-3 vectors with a voyage-3.5 embedder returns confident nonsense rather
 * than an error.
 */

import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../..');

try {
  for (const line of readFileSync(path.join(__dirname, '../.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
} catch { /* rely on process.env */ }

const { createStore } = await import('../lib/store/index.js');
const { loadSubject, resolveStoreConfig } = await import('../lib/subjects.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const DIR       = path.resolve(REPO_ROOT, arg('dir', ''));
const DRY       = has('dry-run');
const BATCH     = Number(arg('batch', 250));

if (!arg('dir', '')) {
  console.error('Usage: node server/scripts/import-export.js --dir data/exports/<subject>-<date> [--subject <slug>] [--dry-run]');
  process.exit(1);
}

/** Supabase row -> canonical chunk. */
function toChunk(row, embedding) {
  const {
    id, source, chunk_index, text, summary, difficulty, origin_context,
    concepts, themes, scripture_refs, philosophical_arguments, cross_text_connections,
    // Deliberately dropped: tfidf_vector was the fallback search index, made
    // obsolete by pgvector; created_at and the export's own bookkeeping are not
    // part of a chunk.
    tfidf_vector, created_at, ordinal, vectorRow,
    ...rest
  } = row;

  return {
    id: String(id),
    documentId: source,
    source,
    chunkIndex: Number.isInteger(chunk_index) ? chunk_index : 0,
    text,
    summary: summary ?? '',
    difficulty: difficulty ?? null,
    concepts: Array.isArray(concepts) ? concepts : [],
    themes: Array.isArray(themes) ? themes : [],
    extras: {
      ...rest,
      ...(origin_context ? { originContext: origin_context } : {}),
      ...(scripture_refs?.length ? { scriptureRefs: scripture_refs } : {}),
      ...(philosophical_arguments?.length ? { philosophicalArguments: philosophical_arguments } : {}),
      ...(cross_text_connections?.length ? { crossTextConnections: cross_text_connections } : {}),
    },
    // These chunks came from flat text ingestion, which never tracked pages.
    pdfPage: null,
    printedPage: null,
    embedding,
  };
}

async function main() {
  const manifest = JSON.parse(await fs.readFile(path.join(DIR, 'manifest.json'), 'utf8'));
  const slug = arg('subject', manifest.subject);
  const dim = manifest.embed.dim;
  const model = manifest.embed.model;

  console.log(`\nImporting ${DIR}`);
  console.log(`  subject : ${slug}`);
  console.log(`  embed   : ${model} @ ${dim} dims`);
  console.log(`  chunks  : ${manifest.counts.exportedChunks} (${manifest.counts.withEmbedding} embedded)\n`);

  const profile = await loadSubject(slug);

  // The profile drives every future query, so a disagreement here would mean
  // searching these vectors with the wrong model forever.
  if (profile.embed.model !== model) {
    console.error(
      `REFUSING: subject "${slug}" is configured for "${profile.embed.model}" but this export was\n` +
      `built with "${model}". Both may be ${dim}-dim, so nothing would error at query time —\n` +
      `the search would just return plausible nonsense.\n\n` +
      `Fix subjects/${slug}/subject.json:  "embed": { "model": "${model}", "dim": ${dim} }`,
    );
    process.exit(2);
  }
  if (profile.embed.dim !== dim) {
    console.error(`REFUSING: subject dim ${profile.embed.dim} != export dim ${dim}`);
    process.exit(2);
  }

  // Read vectors once; the file is dim*N float32, addressed by vectorRow.
  const vecBuf = await fs.readFile(path.join(DIR, 'vectors.f32'));
  const rows = Math.floor(vecBuf.length / 4 / dim);
  console.log(`  vectors.f32: ${rows} rows of ${dim}\n`);

  const readVector = (row) => {
    if (row == null || row < 0 || row >= rows) return null;
    const off = row * dim * 4;
    const out = new Array(dim);
    for (let i = 0; i < dim; i++) out[i] = vecBuf.readFloatLE(off + i * 4);
    return out;
  };

  const lines = (await fs.readFile(path.join(DIR, 'chunks.jsonl'), 'utf8')).split('\n').filter(Boolean);
  console.log(`  chunks.jsonl: ${lines.length} lines\n`);

  if (DRY) {
    const sample = toChunk(JSON.parse(lines[0]), readVector(JSON.parse(lines[0]).vectorRow));
    console.log('Dry run — first chunk maps to:');
    for (const [k, v] of Object.entries(sample)) {
      const s = k === 'embedding' ? `[${v?.length ?? 0} floats]` : JSON.stringify(v);
      console.log(`  ${k.padEnd(12)} ${String(s).slice(0, 90)}`);
    }
    console.log('\nNothing written.');
    return;
  }

  const storeCfg = resolveStoreConfig(profile);
  const store = createStore(storeCfg || undefined);
  if (store.readOnly) {
    console.error(`REFUSING: subject "${slug}" is backed by a read-only store.`);
    process.exit(2);
  }

  await store.initSubject(slug, { dim, embedModel: model, name: profile.name });

  let done = 0;
  let withVec = 0;
  let oversized = 0;
  const OVERSIZE = 12000;   // matches the prompt-side ceiling in claude.js
  for (let i = 0; i < lines.length; i += BATCH) {
    const batch = lines.slice(i, i + BATCH).map((l) => {
      const row = JSON.parse(l);
      const vec = readVector(row.vectorRow);
      if (vec) withVec++;
      if (typeof row.text === "string" && row.text.length > OVERSIZE) oversized++;
      return toChunk(row, vec);
    });
    await store.upsertChunks(slug, batch);
    done += batch.length;
    process.stdout.write(`  imported ${done}/${lines.length}\r`);
  }
  console.log(`  imported ${done}/${lines.length}   `);

  // An oversized chunk is a chunking failure in whatever built the export, and
  // it is expensive: retrieved, it floods the prompt and crowds out the real
  // passages. The theology import carried one of 1.24 MB.
  if (oversized > 0) {
    console.warn(
      `
  WARNING: ${oversized} chunk(s) exceed ${OVERSIZE.toLocaleString()} characters.
` +
      `  These came from a pipeline whose chunking failed. Each one retrieved costs
` +
      `  real money and drowns the passages beside it. Review them before relying on
` +
      `  this subject — usually the same text is already present, correctly chunked.`,
    );
  }

  // Concept map, if the export captured one.
  try {
    const cm = JSON.parse(await fs.readFile(path.join(DIR, 'raw', 'concept_map.json'), 'utf8'));
    const row = Array.isArray(cm) ? cm[0] : cm;
    if (row) {
      await store.saveConceptMap(slug, {
        coreThemes: row.core_themes ?? [],
        concepts: row.concepts ?? [],
        relationships: row.relationships ?? [],
        learningPath: row.learning_path ?? [],
        traditions: row.traditions ?? [],
        builtAt: row.built_at ?? null,
      });
      console.log(`  concept map: ${(row.concepts ?? []).length} concepts, ${(row.core_themes ?? []).length} core themes`);
    }
  } catch { console.log('  concept map: none in export'); }

  // ─── Verify ───────────────────────────────────────────────────────────────
  const meta = await store.getSubjectMeta(slug);
  console.log('\n─── Verification ───────────────────────────────');
  const problems = [];
  const note = (ok, msg) => console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);

  const countOk = meta.chunkCount === lines.length;
  note(countOk, `stored ${meta.chunkCount} / ${lines.length} chunks`);
  if (!countOk) problems.push('chunk count mismatch');

  const embOk = meta.withEmbedding === withVec;
  note(embOk, `embeddings ${meta.withEmbedding} / ${withVec} carried across`);
  if (!embOk) problems.push('embedding count mismatch');

  note(meta.embedModel === model, `model recorded as "${meta.embedModel}"`);
  if (meta.embedModel !== model) problems.push('model not recorded');

  // Round-trip one vector: a chunk must still own the embedding it arrived with.
  const first = JSON.parse(lines[0]);
  const expect = readVector(first.vectorRow);
  const [got] = await store.getChunks(slug, { limit: 1, withEmbeddings: true });
  if (expect && got?.embedding) {
    let maxErr = 0;
    for (let i = 0; i < dim; i++) maxErr = Math.max(maxErr, Math.abs(expect[i] - got.embedding[i]));
    const roundTripOk = got.id === String(first.id) && maxErr < 1e-6;
    note(roundTripOk, `first chunk round-trip: id match, max vector error ${maxErr.toExponential(2)}`);
    if (!roundTripOk) problems.push('vector round-trip mismatch');
  }

  console.log('────────────────────────────────────────────────');
  await store.close();

  if (problems.length) {
    console.error(`\nImport completed WITH PROBLEMS:\n${problems.map(p => `  - ${p}`).join('\n')}`);
    process.exit(2);
  }
  console.log('\nImport verified clean.');
}

main().catch((err) => {
  console.error('\nImport failed:', err.message);
  process.exit(1);
});
