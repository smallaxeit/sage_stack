#!/usr/bin/env node
/**
 * import-askcooter.js — copy an ask_cooter database into a SageStack subject.
 *
 *   node server/scripts/import-askcooter.js --subject softail --dry-run
 *   node server/scripts/import-askcooter.js --subject softail
 *
 * Reads an ask_cooter database and writes an ordinary SageStack subject, so the
 * subject stops being a special case: same database, same shape, same code path
 * as every other subject.
 *
 * The source is only ever READ, and its page scans are only ever copied. The
 * standalone ask_cooter app keeps working exactly as it did.
 *
 * Three things come across:
 *
 *   chunks      with their embeddings as-is. Those vectors cost real money to
 *               produce, and re-embedding would spend it again AND change them.
 *   pages       text, section, specs and diagrams — what the split-pane viewer
 *               shows next to an answer.
 *   scans       the rendered PNGs, copied into this app's own data directory.
 *               Left behind, every citation would open a blank pane the moment
 *               the other project moved or was deleted.
 */

import { readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same .env the server reads, so a migration cannot end up pointed somewhere
// the running app is not.
try {
  for (const line of readFileSync(path.join(__dirname, '../.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
} catch { /* fall back to the ambient environment */ }

const { createStore } = await import('../lib/store/index.js');
const { loadSubject } = await import('../lib/subjects.js');
const { pagesDir } = await import('../lib/ingest/index.js');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i !== -1 ? process.argv[i + 1] : null;
  return v && !v.startsWith('--') ? v : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const SUBJECT = arg('subject', 'softail');
const DRY_RUN = flag('dry-run');
const NO_IMAGES = flag('skip-images');
const BATCH = Number(arg('batch', 200));
const SOURCE_URL = arg('from', process.env.ASKCOOTER_DATABASE_URL);
const IMAGE_SRC = arg('images', process.env.ASKCOOTER_IMAGE_DIR);

const redact = (url) => String(url).replace(/:[^:@/]+@/, ':***@');

async function main() {
  if (!SOURCE_URL) {
    throw new Error('No source database. Set ASKCOOTER_DATABASE_URL in server/.env, or pass --from.');
  }

  const profile = await loadSubject(SUBJECT);

  // One PDF per ask_cooter database, and its filename is not stored there, so
  // the subject profile is what names it.
  const sourceName = profile.store?.sourceName
    ?? Object.keys(profile.sourceAliases ?? {})[0]
    ?? `${SUBJECT}.pdf`;

  const src = new pg.Client({ connectionString: SOURCE_URL });
  await src.connect();

  const totals = await src.query(`
    SELECT (SELECT count(*)::int FROM chunks)           AS chunks,
           (SELECT count(embedding)::int FROM chunks)   AS embedded,
           (SELECT count(*)::int FROM pages)            AS pages,
           (SELECT count(image_path)::int FROM pages)   AS scans`);
  const { chunks: nChunks, embedded: nEmbedded, pages: nPages, scans: nScans } = totals.rows[0];

  const dimRow = await src.query(
    `SELECT vector_dims(embedding) AS dim FROM chunks WHERE embedding IS NOT NULL LIMIT 1`);
  const dim = dimRow.rows[0]?.dim ?? profile.embed.dim;

  const imageDest = pagesDir(SUBJECT);

  console.log(`\n  from    ${redact(SOURCE_URL)}`);
  console.log(`  into    subject "${SUBJECT}" in this app's own store`);
  console.log(`  data    ${nChunks} chunks (${nEmbedded} embedded, ${dim}-dim), ${nPages} pages, ${nScans} scans`);
  console.log(`  named   ${sourceName}`);
  console.log(`  scans   ${NO_IMAGES ? 'skipped (--skip-images)' : `${IMAGE_SRC || '(no source dir)'} -> ${imageDest}`}\n`);

  // Vectors of different widths cannot be mixed, and the failure downstream is
  // a confusing dimension error at query time rather than here.
  if (dim !== profile.embed.dim) {
    throw new Error(
      `Source vectors are ${dim}-dim but subject "${SUBJECT}" declares ${profile.embed.dim}. ` +
      `Fix embed.dim in subjects/${SUBJECT}/subject.json, or re-embed.`);
  }

  if (DRY_RUN) {
    const sample = await src.query(`
      SELECT c.id, c.pdf_page, p.section, left(c.content, 60) AS content
      FROM chunks c JOIN pages p ON p.id = c.page_id ORDER BY c.id LIMIT 3`);
    console.log('Dry run — the first rows would arrive as:');
    for (const r of sample.rows) {
      console.log(`  ${sourceName}::${r.id}  p.${r.pdf_page}  [${r.section ?? '—'}]  ${JSON.stringify(r.content)}`);
    }
    console.log('\nNothing was written.');
    await src.end();
    return;
  }

  // This app's own store — deliberately NOT the subject's current store block,
  // which is the very thing being migrated away from.
  const store = createStore();
  await store.initSubject(SUBJECT, { dim, embedModel: profile.embed.model, name: profile.name });

  // ─── pages ──────────────────────────────────────────────────────────────────
  const pageRows = await src.query(`
    SELECT pdf_page, printed_page, section, markdown, image_path, specs, diagrams
    FROM pages ORDER BY pdf_page`);

  const pages = pageRows.rows.map(p => ({
    source: sourceName,
    pdfPage: p.pdf_page,
    printedPage: p.printed_page,
    section: p.section,
    markdown: p.markdown ?? '',
    // Only the basename is kept. The stored path is relative to another
    // project's root; the directory is this app's configuration.
    imagePath: p.image_path ? path.basename(p.image_path) : null,
    extras: { specs: p.specs ?? [], diagrams: p.diagrams ?? [] },
  }));

  for (let i = 0; i < pages.length; i += BATCH) {
    await store.upsertPages(SUBJECT, pages.slice(i, i + BATCH));
    process.stdout.write(`  pages   ${Math.min(i + BATCH, pages.length)}/${pages.length}\r`);
  }
  console.log(`  pages   ${pages.length}/${pages.length}      `);

  // ─── chunks ─────────────────────────────────────────────────────────────────
  let written = 0;
  for (let offset = 0; ; offset += BATCH) {
    const r = await src.query(`
      SELECT c.id, c.pdf_page, c.chunk_index, c.content, c.embedding::text AS embedding,
             p.printed_page, p.section, p.component_tags, p.specs, p.diagrams
      FROM chunks c JOIN pages p ON p.id = c.page_id
      ORDER BY c.id LIMIT $1 OFFSET $2`, [BATCH, offset]);
    if (r.rowCount === 0) break;

    await store.upsertChunks(SUBJECT, r.rows.map(row => ({
      id: `${sourceName}::${row.id}`,
      documentId: sourceName,
      source: sourceName,
      // ask_cooter's chunk_index restarts on every page, so it is not a
      // document ordinal. Page-major ordering restores one.
      chunkIndex: row.pdf_page * 1000 + row.chunk_index,
      text: row.content,
      summary: '',
      difficulty: null,
      // ask_cooter never ran concept analysis; component tags are the nearest
      // equivalent, and the section is the nearest theme.
      concepts: row.component_tags ?? [],
      themes: row.section ? [row.section] : [],
      extras: {
        section: row.section ?? null,
        specs: row.specs ?? [],
        diagrams: row.diagrams ?? [],
        componentTags: row.component_tags ?? [],
      },
      pdfPage: row.pdf_page,
      printedPage: row.printed_page ?? null,
      embedding: row.embedding ? JSON.parse(row.embedding) : null,
    })));

    written += r.rowCount;
    process.stdout.write(`  chunks  ${written}/${nChunks}\r`);
  }
  console.log(`  chunks  ${written}/${nChunks}      `);

  // ─── scans ──────────────────────────────────────────────────────────────────
  let copied = 0;
  let missingScans = 0;
  if (!NO_IMAGES && IMAGE_SRC) {
    await fs.mkdir(imageDest, { recursive: true });
    for (const p of pages) {
      if (!p.imagePath) continue;
      const from = path.join(IMAGE_SRC, p.imagePath);
      try {
        await fs.copyFile(from, path.join(imageDest, p.imagePath));
        copied++;
      } catch {
        missingScans++;
      }
      if (copied % 50 === 0) process.stdout.write(`  scans   ${copied}/${nScans}\r`);
    }
    console.log(`  scans   ${copied}/${nScans}${missingScans ? ` (${missingScans} not found on disk)` : ''}      `);
  }

  // ─── verification ───────────────────────────────────────────────────────────
  console.log('\n  ── verifying ───────────────────────────────');
  const problems = [];
  const check = (ok, label) => {
    console.log(`  ${ok ? '  ok' : 'FAIL'}  ${label}`);
    if (!ok) problems.push(label);
  };

  const meta = await store.getSubjectMeta(SUBJECT);
  check(meta.chunkCount === nChunks, `chunks ${meta.chunkCount}/${nChunks}`);
  check(meta.withEmbedding === nEmbedded, `embeddings ${meta.withEmbedding}/${nEmbedded}`);

  const probe = pages.find(p => p.markdown.trim());
  const page = probe ? await store.getPage(SUBJECT, probe.pdfPage) : null;
  check(!!page?.markdown, `page ${probe?.pdfPage} text arrived`);

  const sections = await store.listSections(SUBJECT);
  check(sections.length > 0, `${sections.length} sections`);

  // A vector must still belong to the chunk it arrived with — a copy that
  // shuffles them stays silent and returns confident nonsense.
  const first = await src.query(
    `SELECT embedding::text AS e FROM chunks WHERE embedding IS NOT NULL ORDER BY id LIMIT 1`);
  const expected = JSON.parse(first.rows[0].e);
  const [got] = await store.getChunks(SUBJECT, { limit: 1, withEmbeddings: true });
  let worst = 0;
  for (let i = 0; i < expected.length; i++) worst = Math.max(worst, Math.abs(expected[i] - got.embedding[i]));
  check(worst < 1e-6, `first vector round-trip (worst component error ${worst.toExponential(2)})`);

  if (!NO_IMAGES && IMAGE_SRC) check(missingScans === 0, `all ${nScans} scans copied`);
  console.log('  ────────────────────────────────────────────');

  await src.end();
  await store.close();

  if (problems.length) {
    throw new Error(`Imported, but with problems: ${problems.join('; ')}`);
  }

  console.log(`\nImported clean. The source database was not modified.`);
  console.log(`Next: drop the "store" block from subjects/${SUBJECT}/subject.json.\n`);
}

main().catch((err) => {
  console.error(`\nImport failed: ${err.message}\n`);
  process.exit(1);
});
