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
    if (key && !process.env[key]) process.env[key] = val;
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

function chunkByParagraph(text, source) {
  // Split on double newlines (paragraph breaks) first
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
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
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      messages: [{ role: 'user', content: CONCEPT_MAP_PROMPT(conceptData) }],
    });

    const raw = response.content[0].text.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`  Concept map failed: ${err.message}`);
    return { coreThemes: [], concepts: [], relationships: [], learningPath: [] };
  }
}

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveCache(cache) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function chunkHash(chunk) {
  // Simple hash: source + first 100 chars
  return `${chunk.source}::${chunk.text.slice(0, 100)}`;
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

  if (cacheHits > 0) {
    console.log(`   ${cacheHits} from cache, ${toAnalyze.length} need analysis\n`);
    await writeProgress({ status: 'running', phase: 'analyzing', current: cacheHits, total: allChunks.length, pct: Math.round(cacheHits / allChunks.length * 100) });
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
    await writeProgress({ status: 'running', phase: 'analyzing', current: completed, total: allChunks.length, pct, remainingMins: remaining });
  }

  console.log(`\n   Done. ${cacheHits} from cache, ${toAnalyze.length} newly analyzed\n`);

  // 4. Concept map
  console.log('4. Building deep concept map with Claude Sonnet...');
  await writeProgress({ status: 'running', phase: 'concept-map', current: allChunks.length, total: allChunks.length, pct: 98 });
  const sources = [...new Set(allChunks.map(c => c.source))];
  const conceptMap = await buildConceptMap(chunkMeta, sources);
  console.log(`   ${conceptMap.concepts?.length || 0} concepts mapped`);
  console.log(`   ${conceptMap.relationships?.length || 0} relationships`);
  console.log(`   ${conceptMap.traditions?.length || 0} traditions`);
  console.log(`   ${conceptMap.crossTraditionParallels?.length || 0} cross-tradition parallels\n`);

  // 5. TF-IDF vectors
  console.log('5. Building TF-IDF search vectors...');
  const vectors = buildTfidf(allChunks);
  console.log(`   Built ${vectors.length} vectors\n`);

  // 6. Assemble and save
  console.log('6. Saving knowledge base...');
  const knowledgeBase = {
    meta: {
      builtAt: new Date().toISOString(),
      totalChunks: allChunks.length,
      sources: [...new Set(allChunks.map(c => c.source))],
      totalConcepts: conceptMap.concepts?.length || 0,
    },
    conceptMap,
    chunks: allChunks.map((chunk, i) => ({
      id: i,
      source: chunk.source,
      text: chunk.text,
      meta: chunkMeta[i] || {},
      vector: vectors[i],
    })),
  };

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(knowledgeBase, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const sizeMB = ((await fs.stat(OUTPUT_FILE)).size / 1024 / 1024).toFixed(2);

  // 7. Sync to Supabase
  if (supabase) {
    console.log('7. Syncing to Supabase...');
    await writeProgress({ status: 'running', phase: 'syncing', current: allChunks.length, total: allChunks.length, pct: 99 });

    // Upsert chunks in batches of 100
    const rows = knowledgeBase.chunks.map((chunk) => ({
      source: chunk.source,
      chunk_index: chunk.id,
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

  await writeProgress({ status: 'done', phase: 'complete', current: allChunks.length, total: allChunks.length, pct: 100, concepts: conceptMap.concepts?.length || 0 });
  console.log(`\n✓ Knowledge base saved to server/knowledge-base.json`);
  console.log(`  ${allChunks.length} chunks · ${conceptMap.concepts?.length || 0} concepts · ${sizeMB}MB · ${elapsed}s`);
  console.log('\nReady to deploy. Run: npm run dev\n');
}

main().catch(err => {
  console.error('\nBuild failed:', err);
  process.exit(1);
});
