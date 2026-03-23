#!/usr/bin/env node
// One-time script: sync knowledge-base.json to Supabase, then run Voyage embeddings

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { createClient } from '@supabase/supabase-js';
import { buildEmbeddings } from './lib/embeddings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env
try {
  const lines = readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
} catch {}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const kb = JSON.parse(readFileSync(path.join(__dirname, 'knowledge-base.json'), 'utf8'));

console.log(`\nSageStack — Sync & Embed`);
console.log(`Chunks to sync: ${kb.chunks.length}\n`);

// Step 1: Sync chunks to Supabase
console.log('Step 1: Syncing chunks to Supabase...');
const rows = kb.chunks.map((chunk) => ({
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
let errors = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const { error } = await supabase.from('chunks').upsert(batch, { onConflict: 'source,chunk_index' });
  if (error) {
    errors++;
    if (errors <= 3) console.warn(`  Batch ${i} error: ${error.message}`);
  } else {
    process.stdout.write(`  Synced ${Math.min(i + BATCH, rows.length)}/${rows.length}\r`);
  }
}
console.log(`\n✓ Sync complete (${errors} batch errors)`);

// Verify
const { count } = await supabase.from('chunks').select('*', { count: 'exact', head: true });
console.log(`  Supabase now has ${count} chunks\n`);

// Step 2: Build embeddings
console.log('Step 2: Building Voyage embeddings...');
await buildEmbeddings((progress) => {
  process.stdout.write(`  Embedded ${progress.done}/${progress.total} chunks\r`);
});
console.log('\n✓ Embeddings complete!\n');

// Final count
const { count: embedded } = await supabase.from('chunks').select('*', { count: 'exact', head: true }).not('embedding', 'is', null);
console.log(`Summary: ${embedded}/${count} chunks embedded in Supabase`);
