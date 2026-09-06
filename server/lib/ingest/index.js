/**
 * ingest/index.js — document -> chunks -> (analysis) -> embeddings -> store.
 *
 * Subject-scoped end to end: every write names one subject, and the profile
 * supplies chunk sizes, the extract schema, and the embedder configuration.
 *
 * DEGRADES DELIBERATELY. The three stages have different requirements, so the
 * pipeline runs as far as the environment allows and reports what it skipped:
 *
 *   parse + chunk   always works, no keys
 *   embed           needs VOYAGE_API_KEY, or EMBED_DRIVER=local (no key)
 *   analyse         needs ANTHROPIC_API_KEY — enrichment only
 *
 * Without embeddings a document is stored but not searchable, so that is
 * reported as a warning rather than passed off as success. Analysis is
 * genuinely optional: it adds concepts, summaries and subject-specific extras,
 * and retrieval works without it.
 */

import fs from 'fs/promises';
import path from 'path';
import { parseFile } from '../parser.js';
import { chunkText } from './chunk.js';
import { renderExtractSchema } from '../subjects.js';

const ANALYSIS_CONCURRENCY = 8;
const EMBED_BATCH = 128;

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

/** Strip markdown fences and parse. Returns null rather than throwing. */
function parseJsonLoose(text) {
  const raw = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Analyse one chunk. Unlike the previous pipeline, a failure propagates so it
 * can be COUNTED — silently storing an empty analysis leaves a chunk invisible
 * to concept boosting and absent from the concept map, with nothing surfacing
 * how many were affected.
 */
async function analyseChunk(profile, chunk, client, model) {
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
 * Omit `analysisClient` to skip analysis; omit `embedder` to skip embedding
 * (the document is then stored but not searchable, and the result says so).
 */
export async function ingestDocument({
  profile, store, embedder, analysisClient,
  filePath, filename = path.basename(filePath),
  onProgress = () => {},
}) {
  const slug = profile.slug;
  const warnings = [];

  if (profile.ingest.mode === 'vision') {
    throw new Error(
      `Subject "${slug}" is configured for vision ingestion, which is not implemented yet ` +
      `(ARCHITECTURE_PLAN.md Phase 4). Scanned PDFs need per-page rendering plus a vision model. ` +
      `Set ingest.mode to "text" if this document has extractable text.`,
    );
  }

  onProgress({ stage: 'parse', filename });
  const text = await parseFile(filePath);
  if (!text || !text.trim()) {
    throw new Error(
      `No extractable text in "${filename}". If this is a scanned PDF it needs vision ingestion ` +
      `(Phase 4) — pdf-parse returns nothing for image-only pages.`,
    );
  }

  onProgress({ stage: 'chunk', filename });
  const pieces = chunkText(text, profile.ingest);
  if (pieces.length === 0) throw new Error(`"${filename}" produced no chunks`);

  let chunks = pieces.map((t, i) => ({
    id: `${filename}::${i}`,
    documentId: filename,
    source: filename,
    chunkIndex: i,
    text: t,
    summary: '',
    difficulty: null,
    concepts: [],
    themes: [],
    extras: {},
  }));

  // ─── Analysis (optional) ───────────────────────────────────────────────────
  let analysed = 0;
  let analysisFailed = 0;
  if (analysisClient) {
    const model = profile.analysis?.model || 'claude-haiku-4-5';
    onProgress({ stage: 'analyse', filename, done: 0, total: chunks.length });
    const results = await mapWithConcurrency(chunks, ANALYSIS_CONCURRENCY, async (c) => {
      let r = null;
      try {
        r = await analyseChunk(profile, c, analysisClient, model);
        analysed++;
      } catch {
        analysisFailed++;
      }
      onProgress({ stage: 'analyse', filename, done: analysed + analysisFailed, total: chunks.length });
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
      throw new Error(
        `Embedder produces ${embedder.dim} dims but subject "${slug}" is configured for ${profile.embed.dim}.`,
      );
    }
    onProgress({ stage: 'embed', filename, done: 0, total: chunks.length });
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const vectors = await embedder.embedDocuments(batch.map(c => c.text));
      batch.forEach((c, j) => { c.embedding = vectors[j]; });
      embedded += batch.length;
      onProgress({ stage: 'embed', filename, done: embedded, total: chunks.length });
    }
  } else {
    warnings.push('No embedder available — the document is stored but NOT searchable until embeddings are built.');
  }

  // ─── Store ─────────────────────────────────────────────────────────────────
  onProgress({ stage: 'store', filename, total: chunks.length });
  await store.initSubject(slug, {
    dim: profile.embed.dim,
    embedModel: profile.embed.model,
    name: profile.name,
  });
  await store.upsertChunks(slug, chunks);

  return {
    subject: slug,
    filename,
    chunks: chunks.length,
    analysed,
    analysisFailed,
    embedded,
    searchable: embedded > 0,
    warnings,
  };
}

/** Ingest every file in a directory. One bad file does not stop the run. */
export async function ingestDirectory({ dir, ...rest }) {
  const files = await fs.readdir(dir);
  const results = [];
  for (const file of files) {
    const full = path.join(dir, file);
    if (!(await fs.stat(full)).isFile()) continue;
    try {
      results.push(await ingestDocument({ ...rest, filePath: full, filename: file }));
    } catch (err) {
      results.push({ filename: file, error: err.message });
    }
  }
  return results;
}
