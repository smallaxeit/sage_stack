#!/usr/bin/env node
/**
 * Rebuilds knowledge-cache.json from Supabase chunk data.
 * Run this instead of re-analyzing if cache is missing or corrupt.
 *
 * Usage: node server/scripts/rebuild-cache-from-supabase.js
 */

import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, '..', 'knowledge-cache.json');
const CACHE_BAK  = CACHE_FILE + '.bak';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  console.log('Rebuilding cache from Supabase...\n');

  // Paginate through all chunks (Supabase default limit is 1000)
  const PAGE = 1000;
  let from = 0;
  let allChunks = [];

  while (true) {
    const { data, error } = await supabase
      .from('chunks')
      .select('source, text, summary, difficulty, origin_context, concepts, themes, scripture_refs, philosophical_arguments, cross_text_connections')
      .range(from, from + PAGE - 1);

    if (error) throw new Error(`Supabase error: ${error.message}`);
    if (!data || data.length === 0) break;

    allChunks.push(...data);
    console.log(`  Fetched ${allChunks.length} chunks...`);
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`\nTotal fetched: ${allChunks.length} chunks`);

  // Build cache keyed the same way build-knowledge.js keys it
  const cache = {};
  let withAnalysis = 0;

  for (const chunk of allChunks) {
    const key = `${chunk.source}::${chunk.text.slice(0, 100)}`;
    const meta = {
      summary:                 chunk.summary                 || '',
      difficulty:              chunk.difficulty              || '',
      origin_context:          chunk.origin_context          || '',
      concepts:                chunk.concepts                || [],
      themes:                  chunk.themes                  || [],
      scripture_refs:          chunk.scripture_refs          || [],
      philosophical_arguments: chunk.philosophical_arguments || [],
      cross_text_connections:  chunk.cross_text_connections  || [],
    };
    cache[key] = meta;
    if (meta.summary || meta.concepts?.length > 0) withAnalysis++;
  }

  console.log(`Chunks with analysis: ${withAnalysis}/${allChunks.length}`);

  // Atomic write with backup
  const tmp = CACHE_FILE + '.tmp';
  const data = JSON.stringify(cache, null, 2);
  await fs.writeFile(tmp, data);
  try {
    const existing = await fs.readFile(CACHE_FILE, 'utf-8');
    JSON.parse(existing);
    await fs.copyFile(CACHE_FILE, CACHE_BAK);
    console.log('Backed up existing cache to .bak');
  } catch { /* nothing to back up */ }
  await fs.rename(tmp, CACHE_FILE);

  console.log(`\n✓ Cache rebuilt: ${Object.keys(cache).length} entries → knowledge-cache.json`);
}

main().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
