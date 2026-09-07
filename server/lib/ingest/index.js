/**
 * ingest/index.js — document -> pages -> chunks -> (analysis) -> embeddings -> store.
 *
 * Subject-scoped end to end: every write names one subject, and the profile
 * supplies chunk sizes, the extract schema, and the embedder configuration.
 *
 * The original file is kept under data/documents/<slug>/ so the UI can open the
 * exact page a citation came from. That path is independent of the store
 * driver, because a Postgres-backed subject still needs its source PDF on disk
 * to serve.
 *
 * DEGRADES DELIBERATELY. The stages have different requirements, so the
 * pipeline runs as far as the environment allows and reports what it skipped:
 *
 *   parse + chunk   always works, no keys
 *   embed           needs VOYAGE_API_KEY, or EMBED_DRIVER=local (no key)
 *   analyze         needs ANTHROPIC_API_KEY — enrichment only
 *
 * Without embeddings a document is stored but not searchable, which is reported
 * as a warning rather than passed off as success.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chunkPages, chunkText } from './chunk.js';
import { parseDocument, detectIngestMode, textVolume } from './parse.js';
import { renderExtractSchema } from '../subjects.js';
import { renderPages, pageCount } from './render.js';
import { extractPage, estimateVisionCost } from './vision.js';
import { assertValidSlug } from '../store/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../../..');

const ANALYSIS_CONCURRENCY = 8;
const EMBED_BATCH = 128;

/** Where original uploads live, so citations can link back to the real page. */
export function documentsDir(slug) {
  return path.join(REPO_ROOT, 'data/documents', assertValidSlug(slug));
}

/** Reject anything that would escape the subject's document directory. */
export function safeFilename(filename) {
  const base = path.basename(String(filename || '').trim());
  if (!base || base === '.' || base === '..') throw new Error(`Invalid filename: ${filename}`);
  return base;
}

/**
 * Drop chunks whose text is identical to one already seen.
 *
 * Worth doing at ingest because a duplicate is invisible until it costs you:
 * it consumes one of topK retrieval slots, so an answer sees fewer distinct
 * passages than it should, and nothing reports it. The theology corpus arrived
 * with 434 exact duplicates — 8% — found only by reading a search result and
 * noticing the same passage three times at identical scores.
 *
 * Compared on whitespace-normalized text, so the same passage reflowed by a
 * different PDF extraction still matches. Deliberately NOT fuzzy: near-duplicate
 * detection needs a similarity threshold, and a wrong threshold silently
 * discards real content. Exact matching can only ever remove genuine copies.
 */
export function dedupeChunks(pieces) {
  const seen = new Map();       // normalized text -> first index kept
  const kept = [];
  const duplicates = [];

  for (const piece of pieces) {
    const key = String(piece.text ?? '').replace(/\s+/g, ' ').trim();
    if (!key) continue;                       // empty after normalizing
    if (seen.has(key)) { duplicates.push({ text: piece.text, firstAt: seen.get(key) }); continue; }
    seen.set(key, kept.length);
    kept.push(piece);
  }

  return { kept, removed: duplicates.length };
}

/** The generic analysis core, plus whatever the subject asked for. */
export function buildAnalysisPrompt(profile, chunk) {
  const extra = renderExtractSchema(profile);
  return [
    `You are building a knowledge base for: ${profile.name}.`,
    '',
    `SOURCE FILE: ${chunk.source}`,
    'PASSAGE:',
    chunk.text,
    '',
    'Return a single JSON object with this shape:',
    '{',
    '  "concepts": ["string"],',
    '  "themes": ["string"],',
    '  "difficulty": "beginner|intermediate|advanced|scholar",',
    `  "summary": "string"${extra ? ',' : ''}`,
    extra,
    '}',
    '',
    'Return ONLY the JSON object, no other text.',
  ].filter(l => l !== '').join('\n');
}

function parseJsonLoose(text) {
  const raw = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Analyze one chunk. A failure propagates so it can be COUNTED — silently
 * storing an empty analysis leaves a chunk invisible to concept boosting and
 * absent from the concept map, with nothing reporting how many were affected.
 */
async function analyzeChunk(profile, chunk, client, model) {
  const res = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: buildAnalysisPrompt(profile, chunk) }],
  });
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const parsed = parseJsonLoose(text);
  if (!parsed) throw new Error('analysis did not return valid JSON');

  const { concepts, themes, difficulty, summary, ...extras } = parsed;
  return {
    concepts:   Array.isArray(concepts) ? concepts : [],
    themes:     Array.isArray(themes) ? themes : [],
    difficulty: typeof difficulty === 'string' ? difficulty : null,
    summary:    typeof summary === 'string' ? summary : '',
    extras,
  };
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/**
 * Ingest one document into a subject.
 *
 * `keepOriginal` copies the file into data/documents/<slug>/ for the page
 * viewer. Pass false when ingesting in place from a path that already persists.
 */
export async function ingestDocument({
  profile, store, embedder, analysisClient,
  filePath, filename = path.basename(filePath),
  keepOriginal = true,
  onProgress = () => {},
  ...opts
}) {
  const slug = profile.slug;
  const safeName = safeFilename(filename);
  const warnings = [];

  // A scanned document takes a different route entirely: rendered and read
  // page by page rather than parsed. Chosen by the subject, or per document.
  if ((opts.mode ?? profile.ingest.mode) === 'vision') {
    return ingestVisionDocument({
      profile, store, embedder, analysisClient, filePath,
      filename: safeName, keepOriginal, onProgress, ...opts,
    });
  }

  // ─── Parse ─────────────────────────────────────────────────────────────────
  onProgress({ stage: 'parse', filename: safeName });
  const { paged, pages } = await parseDocument(filePath, { ext: path.extname(safeName) });

  // Detect a scan rather than storing an empty knowledge base and calling it
  // success. This is the failure ask_cooter hit: 651 pages, ~0 extractable
  // characters, and pdf-parse reports no error at all.
  const detected = detectIngestMode(pages);
  if (detected === 'vision') {
    throw new Error(
      `"${safeName}" has almost no extractable text (${textVolume(pages)} characters across ` +
      `${pages.length} page(s)) — it is a scan and needs vision ingestion. Set the subject's ` +
      `ingest.mode to "vision", or pass mode:"vision" for this document.`,
    );
  }
  // (vision is handled before this point — see ingestVisionDocument)

  // ─── Chunk ─────────────────────────────────────────────────────────────────
  onProgress({ stage: 'chunk', filename: safeName });
  const rawPieces = chunkPages(pages, profile.ingest);
  if (rawPieces.length === 0) throw new Error(`"${safeName}" produced no chunks`);

  // Before analysis and embedding, because a duplicate costs money at both
  // stages and then costs a retrieval slot forever.
  const { kept: pieces, removed: duplicatesRemoved } = dedupeChunks(rawPieces);
  if (duplicatesRemoved > 0) {
    warnings.push(`${duplicatesRemoved} duplicate chunk(s) removed before analysis — identical text appearing more than once in this document.`);
  }

  let chunks = pieces.map((p, i) => ({
    id: `${safeName}::${i}`,
    documentId: safeName,
    source: safeName,
    chunkIndex: i,
    text: p.text,
    summary: '',
    difficulty: null,
    concepts: [],
    themes: [],
    extras: {},
    pdfPage: p.pdfPage,
    printedPage: p.printedPage,
  }));

  // ─── Analysis (optional) ───────────────────────────────────────────────────
  let analyzed = 0;
  let analysisFailed = 0;
  if (analysisClient) {
    const model = profile.analysis?.model || 'claude-haiku-4-5';
    onProgress({ stage: 'analyze', filename: safeName, done: 0, total: chunks.length });
    const results = await mapWithConcurrency(chunks, ANALYSIS_CONCURRENCY, async (c) => {
      let r = null;
      try { r = await analyzeChunk(profile, c, analysisClient, model); analyzed++; }
      catch { analysisFailed++; }
      onProgress({ stage: 'analyze', filename: safeName, done: analyzed + analysisFailed, total: chunks.length });
      return r;
    });
    chunks = chunks.map((c, i) => (results[i] ? { ...c, ...results[i] } : c));
    if (analysisFailed) {
      warnings.push(`${analysisFailed} of ${chunks.length} chunks failed analysis and were stored without concepts or a summary.`);
    }
  } else {
    warnings.push('No ANTHROPIC_API_KEY — stored without concepts, summaries or subject-specific fields.');
  }

  // ─── Embedding ─────────────────────────────────────────────────────────────
  let embedded = 0;
  if (embedder) {
    if (embedder.dim !== profile.embed.dim) {
      throw new Error(`Embedder produces ${embedder.dim} dims but subject "${slug}" expects ${profile.embed.dim}.`);
    }
    onProgress({ stage: 'embed', filename: safeName, done: 0, total: chunks.length });
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const vectors = await embedder.embedDocuments(batch.map(c => c.text));
      batch.forEach((c, j) => { c.embedding = vectors[j]; });
      embedded += batch.length;
      onProgress({ stage: 'embed', filename: safeName, done: embedded, total: chunks.length });
    }
  } else {
    warnings.push('No embedder available — stored but NOT searchable until embeddings are built.');
  }

  // ─── Keep the original, so citations can open the real page ────────────────
  // The subject decides. A copyrighted manual you may not want sitting on disk;
  // a reference set you browse constantly you certainly do. Without the file
  // there is nothing for a citation to open, so this is a real tradeoff rather
  // than a preference. The caller can still override per document.
  const retain = keepOriginal && profile.ingest.keepOriginal !== false;
  if (retain) {
    const dir = documentsDir(slug);
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, safeName);
    if (path.resolve(dest) !== path.resolve(filePath)) await fs.copyFile(filePath, dest);
  }

  // ─── Store ─────────────────────────────────────────────────────────────────
  if (!retain) {
    warnings.push(
      'Original file not kept (ingest.keepOriginal is false) — citations for this ' +
      'document will have no page to open.',
    );
  }

  onProgress({ stage: 'store', filename: safeName, total: chunks.length });
  await store.initSubject(slug, {
    dim: profile.embed.dim,
    embedModel: profile.embed.model,
    name: profile.name,
  });
  await store.upsertChunks(slug, chunks);

  return {
    subject: slug,
    filename: safeName,
    paged,
    pages: pages.length,
    chunks: chunks.length,
    duplicatesRemoved,
    analyzed,
    analysisFailed,
    embedded,
    searchable: embedded > 0,
    originalKept: retain,
    warnings,
  };
}

/**
 * Ingest a scanned document by looking at every page.
 *
 * Committed PAGE BY PAGE, which is the whole design. A several-hundred-page run
 * will hit a rate limit or a transient error somewhere, and a run that has to
 * start over each time never finishes. Re-running skips pages already stored,
 * so it resumes; pages that fail are collected and reported rather than
 * aborting the batch.
 *
 * This is the expensive path — one vision call per page — so it reports an
 * estimate before starting and the real usage after.
 */
export async function ingestVisionDocument({
  profile, store, embedder, analysisClient,
  filePath, filename, keepOriginal = true,
  scale = 2,
  start = 0,
  end = null,
  resume = true,
  onProgress = () => {},
}) {
  const slug = profile.slug;
  const safeName = safeFilename(filename);
  const warnings = [];

  if (!analysisClient) {
    throw new Error(
      'Vision ingestion needs ANTHROPIC_API_KEY — the page images have to be read by a model. ' +
      'There is no offline path for a scan.',
    );
  }

  const total = await pageCount(filePath);
  const last = end == null ? total : Math.min(end, total);
  const estimate = estimateVisionCost(last - start, { model: profile.ingest.visionModel });

  onProgress({ stage: 'vision', filename: safeName, done: 0, total: last - start, estimateUsd: estimate.usd });

  // Which pages are already stored? Chunk ids are "<file>::p<page>::<n>", so
  // the stored set is derivable without a separate bookkeeping table.
  const done = new Set();
  if (resume) {
    try {
      for (const c of await store.getChunks(slug)) {
        if (c.source === safeName && c.pdfPage != null) done.add(c.pdfPage);
      }
    } catch { /* nothing stored yet */ }
  }
  if (done.size > 0) {
    warnings.push(`Resumed: ${done.size} page(s) were already stored and were not re-read.`);
  }

  await store.initSubject(slug, {
    dim: profile.embed.dim,
    embedModel: profile.embed.model,
    name: profile.name,
  });

  const extraSchema = renderExtractSchema(profile);
  const failures = [];
  let pagesRead = 0;
  let chunksStored = 0;
  let embedded = 0;
  let usageIn = 0;
  let usageOut = 0;

  for await (const { pdfPage, png } of renderPages(filePath, { start, end: last, scale, skip: done })) {
    let page;
    try {
      page = await extractPage({
        client: analysisClient,
        profile,
        png,
        pdfPage,
        model: profile.ingest.visionModel || undefined,
        extraSchema,
      });
    } catch (err) {
      failures.push({ pdfPage, error: err.message });
      onProgress({ stage: 'vision', filename: safeName, done: pagesRead, total: last - start, failed: failures.length });
      continue;
    }

    pagesRead++;
    usageIn  += page.usage?.input_tokens ?? 0;
    usageOut += page.usage?.output_tokens ?? 0;

    if (page.isBlank || !page.markdown.trim()) {
      onProgress({ stage: 'vision', filename: safeName, done: pagesRead, total: last - start });
      continue;
    }

    // A manual's pages are self-contained units, so chunking stays WITHIN a
    // page here — unlike prose ingestion, which packs across page boundaries.
    // It also keeps the page/chunk mapping exact, which is what citations need.
    const pieces = chunkText(page.markdown, profile.ingest);
    const { kept } = dedupeChunks(pieces.map(t => ({ text: t })));

    const chunks = kept.map((p, i) => ({
      id: `${safeName}::p${pdfPage}::${i}`,
      documentId: safeName,
      source: safeName,
      chunkIndex: pdfPage * 1000 + i,   // page-ordered, stable across resumes
      text: p.text,
      summary: '',
      difficulty: null,
      concepts: page.componentTags,
      themes: page.section ? [page.section] : [],
      extras: { section: page.section, ...page.extras },
      pdfPage,
      printedPage: page.printedPage,
    }));

    if (embedder) {
      const vectors = await embedder.embedDocuments(chunks.map(c => c.text));
      chunks.forEach((c, i) => { c.embedding = vectors[i]; });
      embedded += chunks.length;
    }

    // Committed here, per page — this is what makes the run resumable.
    await store.upsertChunks(slug, chunks);
    chunksStored += chunks.length;

    onProgress({
      stage: 'vision', filename: safeName,
      done: pagesRead, total: last - start,
      chunks: chunksStored, failed: failures.length,
    });
  }

  if (keepOriginal && profile.ingest.keepOriginal !== false) {
    const dir = documentsDir(slug);
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, safeName);
    if (path.resolve(dest) !== path.resolve(filePath)) await fs.copyFile(filePath, dest);
  }

  if (failures.length > 0) {
    warnings.push(
      `${failures.length} page(s) failed and were skipped. Re-run to retry only those — ` +
      `pages already stored are not read again.`,
    );
  }
  if (!embedder) {
    warnings.push('No embedder available — pages are stored but NOT searchable.');
  }

  return {
    subject: slug,
    filename: safeName,
    mode: 'vision',
    paged: true,
    pages: pagesRead,
    resumedFrom: done.size,
    chunks: chunksStored,
    embedded,
    failures,
    searchable: embedded > 0,
    usage: { inputTokens: usageIn, outputTokens: usageOut },
    estimateUsd: estimate.usd,
    warnings,
  };
}

/**
 * Ingest every file in a directory. One bad file does not stop the run.
 *
 * `onDocument({ filename, index, total, result?, error? })` fires as each file
 * finishes, and `onProgress` is forwarded per document, so a caller can report
 * both which file is running and how far through it is.
 *
 * Dotfiles are skipped: a source directory is kept in git with a .gitkeep, and
 * trying to parse that produces a confusing failure for something that is not
 * a document at all.
 */
export async function ingestDirectory({ dir, onDocument = () => {}, onProgress = () => {}, ...rest }) {
  const entries = await fs.readdir(dir);
  const files = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if ((await fs.stat(full)).isFile()) files.push({ name, full });
  }

  const results = [];
  for (const [index, { name, full }] of files.entries()) {
    onDocument({ filename: name, index, total: files.length });
    try {
      const result = await ingestDocument({
        ...rest,
        filePath: full,
        filename: name,
        onProgress: (p) => onProgress({ ...p, filename: name, index, total: files.length }),
      });
      results.push(result);
      onDocument({ filename: name, index, total: files.length, result });
    } catch (err) {
      const failed = { filename: name, error: err.message };
      results.push(failed);
      onDocument({ filename: name, index, total: files.length, error: err.message });
    }
  }
  return results;
}
