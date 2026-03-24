#!/usr/bin/env node
/**
 * build-knowledge.js
 *
 * Pre-build pipeline. Run once before deployment:
 *   npm run build:knowledge
 *
 * Steps:
 *   1. Parse all files in /server/content/
 *   2. Chunk intelligently (paragraph-aware)
 *   3. Claude analyzes each chunk batch → extracts concepts, themes, scripture refs
 *   4. Claude synthesizes a full concept map across all content
 *   5. Build TF-IDF vectors for semantic search
 *   6. Save everything to /server/knowledge-base.json
 */

import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { loadContentDir } from './lib/parser.js';
import { buildEmbeddings } from './lib/embeddings.js';
import { friendlySourceName } from './lib/claude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env manually — reliable in ESM regardless of cwd
try {
  const envPath = path.join(__dirname, '.env');
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key) process.env[key] = val; // always override — child process inherits parent env
  }
} catch { /* .env not found, rely on existing process.env */ }

const CONTENT_DIR = path.join(__dirname, '../source');
const OUTPUT_FILE = path.join(__dirname, 'knowledge-base.json');
const CACHE_FILE = path.join(__dirname, 'knowledge-cache.json');
const PROGRESS_FILE = path.join(__dirname, 'build-progress.json');

async function writeProgress(data) {
  await fs.writeFile(PROGRESS_FILE, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }));
}

const client = new Anthropic();

// Supabase client for syncing built knowledge
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

// ─── Chunking ────────────────────────────────────────────────────────────────

const CHUNK_TARGET = 400;   // target words per chunk
const CHUNK_MIN    = 100;   // don't save tiny orphan chunks

function normalizeText(text) {
  // Gutenberg .txt files use hard line-wrapping at ~70 chars with single newlines.
  // Join those wrapped lines into full paragraphs, preserving real paragraph breaks.
  return text
    .replace(/\r\n/g, '\n')
    // Preserve double newlines as paragraph markers
    .replace(/\n{2,}/g, '\x00')
    // Join hard-wrapped lines (single newline, next line is lowercase or mid-sentence)
    .replace(/\n([a-z\(\"\'])/g, ' $1')
    .replace(/\n/g, ' ')
    // Restore paragraph breaks
    .replace(/\x00/g, '\n\n');
}

function chunkByParagraph(text, source) {
  // Only normalize hard-wrapped text for .txt files (e.g. Gutenberg)
  // PDFs are already clean from pdf-parse — normalizing them would break cache keys
  const normalized = source.endsWith('.txt') ? normalizeText(text) : text;
  const paragraphs = normalized.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let current = [];
  let wordCount = 0;

  for (const para of paragraphs) {
    const words = para.split(/\s+/).length;
    if (wordCount + words > CHUNK_TARGET && current.length > 0) {
      const text = current.join('\n\n');
      if (text.split(/\s+/).length >= CHUNK_MIN) {
        chunks.push({ source, text });
      }
      current = [para];
      wordCount = words;
    } else {
      current.push(para);
      wordCount += words;
    }
  }

  if (current.length > 0) {
    const text = current.join('\n\n');
    if (text.split(/\s+/).length >= CHUNK_MIN) {
      chunks.push({ source, text });
    }
  }

  return chunks;
}

// ─── TF-IDF ──────────────────────────────────────────────────────────────────

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
}

function buildTfidf(chunks) {
  const N = chunks.length;
  const df = {}; // document frequency per term

  const termFreqs = chunks.map(chunk => {
    const tokens = tokenize(chunk.text);
    const tf = {};
    for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
    return tf;
  });

  // Count DF
  for (const tf of termFreqs) {
    for (const term of Object.keys(tf)) {
      df[term] = (df[term] || 0) + 1;
    }
  }

  // Build TF-IDF vectors
  return termFreqs.map(tf => {
    const vec = {};
    for (const [term, freq] of Object.entries(tf)) {
      const idf = Math.log((N + 1) / (df[term] + 1));
      vec[term] = freq * idf;
    }
    return vec;
  });
}

// ─── Claude analysis ─────────────────────────────────────────────────────────

const CHUNK_ANALYSIS_PROMPT = (chunk) => `You are a scholar of theology and philosophy building a deep knowledge base. Analyze the passage below with rigorous depth.

SOURCE FILE: ${chunk.source}
PASSAGE:
${chunk.text}

Extract a comprehensive analysis. Return a single JSON object:
{
  "concepts": ["string"],           // theological and philosophical concepts present (no limit — be thorough)
  "themes": ["string"],             // broader themes and doctrines
  "scriptureRefs": ["string"],      // scripture/text references cited or implied (e.g. "Genesis 1:1", "Surah 2:255")
  "philosophicalArguments": [       // any logical arguments or reasoning structures present
    {
      "claim": "string",            // the proposition being made
      "reasoning": "string",        // the logical basis or support given
      "tradition": "string"         // which tradition/school this argument belongs to
    }
  ],
  "crossTextConnections": ["string"],  // concepts or arguments that likely appear in other source texts too
  "difficulty": "beginner|intermediate|advanced|scholar",
  "summary": "string",              // 2-3 sentence deep summary — capture the argument, not just the topic
  "originContext": "string"         // what book/section/tradition this passage is from, based on the source file name and content
}

Return ONLY the JSON object, no other text.`;

const CONCEPT_MAP_PROMPT = (conceptData) => `You are a scholar of comparative theology and philosophy synthesizing a deep knowledge map from multiple sacred and philosophical texts.

The source material spans: ${conceptData.sources.join(', ')}

Here are all concepts, arguments, and cross-text connections extracted from the material:
${JSON.stringify(conceptData.concepts, null, 2)}

Philosophical arguments found:
${JSON.stringify(conceptData.arguments, null, 2)}

Build a comprehensive, scholarly concept map. Return JSON in this exact shape:
{
  "coreThemes": ["string"],         // 8-15 major overarching themes across all texts
  "traditions": [                   // breakdown of theological/philosophical traditions present
    {
      "name": "string",
      "sourceFiles": ["string"],
      "coreBeliefs": ["string"],
      "distinctiveConcepts": ["string"]
    }
  ],
  "concepts": [
    {
      "name": "string",
      "description": "string",          // rigorous 2-3 sentence definition grounded in the source material
      "relatedConcepts": ["string"],
      "themes": ["string"],
      "traditions": ["string"],         // which traditions hold or use this concept
      "sourceFiles": ["string"],        // which source files contain this concept
      "appearsAcrossTraditions": true   // true if concept appears in multiple traditions
    }
  ],
  "relationships": [
    {
      "from": "string",
      "to": "string",
      "type": "string",                 // "enables", "contrasts_with", "requires", "leads_to", "part_of", "parallels", "contradicts", "fulfills"
      "description": "string",          // 1-2 sentence explanation of the relationship
      "sourceTraditions": ["string"]    // which traditions assert this relationship
    }
  ],
  "crossTraditionParallels": [          // concepts that appear across multiple traditions with different names/frames
    {
      "concept": "string",
      "manifestations": [{ "tradition": "string", "name": "string", "description": "string" }]
    }
  ],
  "learningPath": ["string"],           // suggested concept order for a student starting from scratch
  "advancedTopics": ["string"]          // deep topics for advanced students
}

Return ONLY the JSON object, no other text.`;

async function analyzeChunk(chunk, idx, total) {
  process.stdout.write(`  [${idx}/${total}] ${chunk.source} ... `);
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: CHUNK_ANALYSIS_PROMPT(chunk) }],
    });

    const raw = response.content[0].text.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const parsed = JSON.parse(raw);
    parsed._model = 'haiku';
    console.log('✓');
    return parsed;
  } catch (err) {
    console.log(`failed (${err.message})`);
    return { concepts: [], themes: [], scriptureRefs: [], philosophicalArguments: [], crossTextConnections: [], difficulty: 'intermediate', summary: '', originContext: chunk.source, _model: null };
  }
}

async function buildConceptMap(allMeta, sources) {
  console.log('\n  Building concept map with Claude Sonnet...');

  // Deduplicate concepts with frequency
  const freq = {};
  for (const m of allMeta) for (const c of (m.concepts || [])) freq[c] = (freq[c] || 0) + 1;
  const topConcepts = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 150).map(([c]) => c);

  // Collect unique philosophical arguments (sample)
  const allArgs = allMeta.flatMap(m => m.philosophicalArguments || []).slice(0, 50);

  const conceptData = { sources, concepts: topConcepts, arguments: allArgs };

  try {
    // Use streaming to avoid connection timeouts on large responses
    let fullText = '';
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      messages: [{ role: 'user', content: CONCEPT_MAP_PROMPT(conceptData) }],
    });
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        fullText += chunk.delta.text;
      }
    }
    const raw = fullText.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    return JSON.parse(raw);
  } catch (err) {
    // Re-throw so the build fails loudly rather than silently writing an empty concept map
    throw new Error(`Concept map failed: ${err.message}`);
  }
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

const CACHE_BAK = CACHE_FILE + '.bak';

async function loadCache() {
  let primaryErr = null;

  // Try primary
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    console.log(`  Cache loaded: ${Object.keys(parsed).length} entries`);
    return parsed;
  } catch (e) {
    primaryErr = e.message;
  }

  // Try backup
  try {
    const raw = await fs.readFile(CACHE_BAK, 'utf-8');
    const parsed = JSON.parse(raw);
    console.error(`  ❌ PRIMARY CACHE CORRUPT: ${primaryErr}`);
    console.warn(`  ⚠️  Restored from backup — ${Object.keys(parsed).length} entries recovered. Last batch may be missing.`);
    return parsed;
  } catch (e) {
    // Both failed — this is a real problem
    const primaryMissing = primaryErr.includes('ENOENT');
    if (primaryMissing) {
      console.log('  No cache found — starting fresh');
    } else {
      const errMsg = `CACHE UNRECOVERABLE — Primary: ${primaryErr} | Backup: ${e.message}`;
      console.error(`\n  ❌ ${errMsg}`);
      console.error(`     All prior analysis will be re-run. Check disk for corruption.\n`);
      // Write to progress file immediately so the UI shows it
      await writeProgress({ status: 'error', phase: 'cache', message: errMsg });
      // Also append to a persistent error log
      const LOG_FILE = path.join(__dirname, 'build-errors.log');
      const entry = `[${new Date().toISOString()}] ${errMsg}\n`;
      await fs.appendFile(LOG_FILE, entry);
    }
    return {};
  }
}

async function saveCache(cache) {
  const tmp = CACHE_FILE + '.tmp';
  const data = JSON.stringify(cache, null, 2);
  // 1. write to temp
  await fs.writeFile(tmp, data);
  // 2. promote current → backup (if current exists and is valid)
  try {
    const existing = await fs.readFile(CACHE_FILE, 'utf-8');
    JSON.parse(existing); // only back up if it's valid JSON
    await fs.copyFile(CACHE_FILE, CACHE_BAK);
  } catch { /* no valid current to back up */ }
  // 3. atomic promote temp → primary
  await fs.rename(tmp, CACHE_FILE);
}

function chunkHash(chunk) {
  // Simple hash: source + first 100 chars
  return `${chunk.source}::${chunk.text.slice(0, 100)}`;
}

// ─── Reading list updater ─────────────────────────────────────────────────────

const READING_LIST = path.join(__dirname, '../READING_LIST.md');

async function updateReadingList(chunks) {
  try {
    const loadedSources = new Set(chunks.map(c => c.source.replace('.pdf', '').toLowerCase()));
    let md = await fs.readFile(READING_LIST, 'utf-8');

    // Process each line — match checked items and stamp analyzed ones
    md = md.split('\n').map(line => {
      // Match lines like: - [x] Some Title or - [x] Some Title ✓ analyzed
      const match = line.match(/^(\s*-\s*\[)(x)(\]\s*)(.+?)(\s*✓ analyzed)?$/i);
      if (!match) return line;

      const prefix   = match[1]; // "- ["
      const check    = match[2]; // "x"
      const middle   = match[3]; // "] "
      const title    = match[4].trim();
      const already  = !!match[5];

      // Normalize title to compare against loaded sources
      // Strip author prefix "Author — *Title*" → just title
      const cleanTitle = title
        .replace(/^.*?—\s*/, '')        // remove "Author — "
        .replace(/\*/g, '')              // remove markdown bold/italic
        .replace(/\s*\(.*?\)/g, '')      // remove parenthetical "(selections)"
        .trim()
        .toLowerCase();

      const isLoaded = [...loadedSources].some(s =>
        s.includes(cleanTitle.slice(0, 12)) || cleanTitle.includes(s.slice(0, 12))
      );

      if (isLoaded && !already) {
        return `${prefix}${check}${middle}${title} ✓ analyzed`;
      }
      return line;
    }).join('\n');

    await fs.writeFile(READING_LIST, md);
    console.log('8. Reading list updated ✓');
  } catch (err) {
    console.warn('   Could not update reading list:', err.message);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  await writeProgress({ status: 'starting', phase: 'init', current: 0, total: 0, pct: 0 });
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║     Knowledge Base Build Pipeline     ║');
  console.log('╚═══════════════════════════════════════╝\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY not set. Copy server/.env.example to server/.env');
    process.exit(1);
  }

  // 1. Parse content
  console.log('1. Parsing content files...');
  const docs = await loadContentDir(CONTENT_DIR);
  if (docs.length === 0) {
    console.error('ERROR: No content files found in /server/content/');
    process.exit(1);
  }
  console.log(`   Found ${docs.length} files\n`);

  // 2. Chunk
  console.log('2. Chunking content (paragraph-aware)...');
  const allChunks = [];
  for (const doc of docs) {
    const chunks = chunkByParagraph(doc.text, doc.source);
    allChunks.push(...chunks);
    console.log(`   ${doc.source}: ${chunks.length} chunks`);
  }
  console.log(`   Total: ${allChunks.length} chunks\n`);

  // Write initial source list so the admin UI can show all sources (including new ones at 0%) immediately
  const allSources = [...new Set(allChunks.map(c => c.source))];
  await writeProgress({
    status: 'running', phase: 'analyzing', current: 0, total: allChunks.length, pct: 0,
    sourceProgress: allSources.map(filename => ({ filename, source: friendlySourceName(filename), total: allChunks.filter(c => c.source === filename).length, analyzed: 0 })),
  });

  // 3. Deep AI analysis with caching (Sonnet, per-chunk)
  console.log('3. Analyzing chunks with Claude Sonnet (deep mode)...');
  console.log(`   ${allChunks.length} chunks to analyze — caching enabled, safe to interrupt\n`);
  const cache = await loadCache();
  const chunkMeta = [];
  let cacheHits = 0;
  let saveInterval = 0;

  const CONCURRENCY = 5;
  let completed = 0;

  // Separate cached vs needs-analysis
  const toAnalyze = [];
  for (let i = 0; i < allChunks.length; i++) {
    const key = chunkHash(allChunks[i]);
    if (cache[key] && (cache[key].concepts?.length > 0 || cache[key].summary?.length > 0)) {
      chunkMeta[i] = cache[key];
      cacheHits++;
      completed++;
    } else {
      toAnalyze.push(i);
    }
  }

  // Helper: compute per-source analyzed counts from current chunkMeta state
  function sourceProgress() {
    const map = {};
    for (let i = 0; i < allChunks.length; i++) {
      const src = allChunks[i].source;
      if (!map[src]) map[src] = { total: 0, analyzed: 0 };
      map[src].total++;
      if (chunkMeta[i]?.summary) map[src].analyzed++;
    }
    return Object.entries(map).map(([filename, s]) => ({
      filename,
      source: friendlySourceName(filename),
      total: s.total,
      analyzed: s.analyzed,
    }));
  }

  if (cacheHits > 0) {
    console.log(`   ${cacheHits} from cache, ${toAnalyze.length} need analysis\n`);
    await writeProgress({ status: 'running', phase: 'analyzing', current: cacheHits, total: allChunks.length, pct: Math.round(cacheHits / allChunks.length * 100), sourceProgress: sourceProgress() });
  }

  // Process in parallel batches
  for (let b = 0; b < toAnalyze.length; b += CONCURRENCY) {
    const batch = toAnalyze.slice(b, b + CONCURRENCY);
    await Promise.all(batch.map(async (i) => {
      const meta = await analyzeChunk(allChunks[i], i + 1, allChunks.length);
      chunkMeta[i] = meta;
      cache[chunkHash(allChunks[i])] = meta;
      completed++;
    }));

    await saveCache(cache);
    saveInterval += batch.length;

    const pct = Math.round(completed / allChunks.length * 100);
    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const rate = (b + batch.length) / (Date.now() - startTime) * 1000;
    const remaining = Math.round((toAnalyze.length - b - batch.length) / rate / 60);
    const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
    console.log(`\n  [${bar}] ${pct}% — ${completed}/${allChunks.length} — ${elapsed}m elapsed — ~${remaining}m remaining\n`);
    await writeProgress({ status: 'running', phase: 'analyzing', current: completed, total: allChunks.length, pct, remainingMins: remaining, sourceProgress: sourceProgress() });
  }

  console.log(`\n   Done. ${cacheHits} from cache, ${toAnalyze.length} newly analyzed\n`);

  // 4. Concept map
  console.log('4. Building deep concept map with Claude Sonnet...');
  await writeProgress({ status: 'running', phase: 'concept-map', current: allChunks.length, total: allChunks.length, pct: 98 });
  const sources = [...new Set(allChunks.map(c => c.source))];
  const conceptMap = await buildConceptMap(chunkMeta, sources);

  if (!conceptMap.concepts?.length) {
    await writeProgress({ status: 'error', phase: 'concept-map', message: 'Concept map returned empty — check Claude API key and credits' });
    throw new Error('Concept map returned 0 concepts. Build aborted to avoid overwriting good data.');
  }

  console.log(`   ${conceptMap.concepts?.length || 0} concepts mapped`);
  console.log(`   ${conceptMap.relationships?.length || 0} relationships`);
  console.log(`   ${conceptMap.traditions?.length || 0} traditions`);
  console.log(`   ${conceptMap.crossTraditionParallels?.length || 0} cross-tradition parallels\n`);

  // 5. TF-IDF vectors
  console.log('5. Building TF-IDF search vectors...');
  const vectors = buildTfidf(allChunks);
  console.log(`   Built ${vectors.length} vectors\n`);

  // Attach meta to each chunk before sync + stats
  allChunks.forEach((chunk, i) => { chunk.meta = chunkMeta[i] || {}; });

  // 6. Save lightweight meta file (sources + concept map — all the server needs at startup)
  console.log('6. Saving knowledge meta...');
  const sourceStats = sources.map(src => {
    const srcChunks = allChunks.filter(c => c.source === src);
    return {
      filename: src,
      total: srcChunks.length,
      analyzed: srcChunks.filter(c => c.meta?.summary).length,
    };
  });
  const knowledgeMeta = {
    builtAt: new Date().toISOString(),
    totalChunks: allChunks.length,
    sources,
    sourceStats,
    totalConcepts: conceptMap.concepts?.length || 0,
    conceptMap,
  };
  const META_FILE = path.join(__dirname, 'knowledge-meta.json');
  await fs.writeFile(META_FILE, JSON.stringify(knowledgeMeta, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const sizeMB = ((await fs.stat(META_FILE)).size / 1024 / 1024).toFixed(2);

  // 7. Sync to Supabase
  if (supabase) {
    console.log('7. Syncing to Supabase...');
    await writeProgress({ status: 'running', phase: 'syncing', current: allChunks.length, total: allChunks.length, pct: 99 });

    // Upsert chunks in batches of 100
    const rows = allChunks.map((chunk, i) => ({
      source: chunk.source,
      chunk_index: i,
      text: chunk.text,
      summary: chunk.meta?.summary || null,
      difficulty: chunk.meta?.difficulty || null,
      origin_context: chunk.meta?.originContext || null,
      concepts: chunk.meta?.concepts || [],
      themes: chunk.meta?.themes || [],
      scripture_refs: chunk.meta?.scriptureRefs || [],
      philosophical_arguments: chunk.meta?.philosophicalArguments || [],
      cross_text_connections: chunk.meta?.crossTextConnections || [],
      tfidf_vector: chunk.vector || {},
    }));

    const BATCH = 100;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const { error } = await supabase.from('chunks').upsert(batch, { onConflict: 'source,chunk_index' });
      if (error) console.warn(`  Supabase batch ${i}-${i + BATCH} error:`, error.message);
      else process.stdout.write(`  Synced ${Math.min(i + BATCH, rows.length)}/${rows.length} chunks\r`);
    }

    // Save concept map
    if (conceptMap.concepts?.length > 0) {
      await supabase.from('concept_map').delete().neq('id', '00000000-0000-0000-0000-000000000000'); // clear old
      await supabase.from('concept_map').insert({
        core_themes: conceptMap.coreThemes || [],
        concepts: conceptMap.concepts || [],
        relationships: conceptMap.relationships || [],
        learning_path: conceptMap.learningPath || [],
        traditions: conceptMap.traditions || [],
      });
    }

    console.log(`\n  ✓ Supabase synced — ${rows.length} chunks`);
  }

  // 8. Update reading list
  await updateReadingList(allChunks);

  // 9. Build Voyage embeddings for all un-embedded chunks
  if (supabase && process.env.VOYAGE_API_KEY) {
    console.log('9. Building embeddings (Voyage AI)...');
    await writeProgress({ status: 'running', phase: 'embedding', current: 0, total: allChunks.length, pct: 99 });
    let embeddedCount = 0;
    await buildEmbeddings((progress) => {
      embeddedCount = progress.done || embeddedCount;
      process.stdout.write(`  Embedded ${progress.done}/${progress.total} chunks\r`);
    });
    console.log(`\n  ✓ Embeddings complete`);
  } else {
    console.log('9. Skipping embeddings — VOYAGE_API_KEY or Supabase not configured');
  }

  await writeProgress({ status: 'done', phase: 'complete', current: allChunks.length, total: allChunks.length, pct: 100, concepts: conceptMap.concepts?.length || 0, sources: sources.length });
  console.log(`\n✓ Knowledge base saved to server/knowledge-base.json`);
  console.log(`  ${allChunks.length} chunks · ${conceptMap.concepts?.length || 0} concepts · ${sizeMB}MB · ${elapsed}s`);
  console.log('\nReady to deploy. Run: npm run dev\n');
}

main().catch(async err => {
  const errMsg = err.stack || err.message;
  console.error('\n❌ Build failed:', errMsg);
  const LOG_FILE = path.join(__dirname, 'build-errors.log');
  const entry = `[${new Date().toISOString()}] BUILD CRASH: ${errMsg}\n`;
  try { await fs.appendFile(LOG_FILE, entry); } catch {}
  try {
    await fs.writeFile(PROGRESS_FILE, JSON.stringify({
      status: 'error',
      phase: 'crashed',
      message: err.message,
      updatedAt: new Date().toISOString(),
    }));
  } catch {}
  process.exit(1);
});
