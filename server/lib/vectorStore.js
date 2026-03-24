import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase } from './supabase.js';
import { searchByEmbedding } from './embeddings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const META_FILE = path.join(__dirname, '../knowledge-meta.json'); // tiny — sources list only

let conceptMap = null;
let knownSources = [];
let sourceStats = [];
let initialized = false;

// ─── Initialize ───────────────────────────────────────────────────────────────

export async function loadKnowledgeBase() {
  // 1. Load sources + concept map from local meta file (tiny, fast — no chunks)
  try {
    const raw = await fs.readFile(META_FILE, 'utf-8');
    const meta = JSON.parse(raw);
    knownSources = meta.sources || [];
    sourceStats  = meta.sourceStats || [];
    if (meta.conceptMap) conceptMap = meta.conceptMap;
  } catch {
    // No meta file yet — will be written after first build
  }

  const totalConcepts = conceptMap?.concepts?.length || 0;
  console.log(`Knowledge base: ${knownSources.length} sources, ${totalConcepts} concepts`);
  initialized = knownSources.length > 0 || totalConcepts > 0;
  return initialized;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export async function search(query, topK = 10) {
  const results = await searchByEmbedding(query, topK);
  if (results && results.length > 0) {
    console.log(`[search] pgvector — ${results.length} results`);
    return results;
  }
  console.warn('[search] pgvector returned no results');
  return [];
}

// ─── Getters ──────────────────────────────────────────────────────────────────

export function getConceptMap()    { return conceptMap; }
export function getSources()       { return knownSources; }
export function isReady()          { return initialized; }
export function getMeta()          { return { totalConcepts: conceptMap?.concepts?.length || 0, sources: knownSources, sourceStats }; }
export function getKnowledgeBase() { return { conceptMap, sources: knownSources }; }
