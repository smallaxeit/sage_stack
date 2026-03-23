import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_FILE = path.join(__dirname, '../knowledge-base.json');

let chunks = [];
let conceptMap = null;
let meta = null;

// ─── Cosine similarity ────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0, normA = 0, normB = 0;
  for (const k of keys) {
    const va = a[k] || 0;
    const vb = b[k] || 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ─── Query vector (TF-IDF style) ──────────────────────────────────────────────

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
}

function queryVector(text) {
  const tokens = tokenize(text);
  const tf = {};
  for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
  return tf;
}

// ─── Load ─────────────────────────────────────────────────────────────────────

export async function loadKnowledgeBase() {
  try {
    const raw = await fs.readFile(KB_FILE, 'utf-8');
    const kb = JSON.parse(raw);
    chunks = kb.chunks || [];
    conceptMap = kb.conceptMap || null;
    meta = kb.meta || null;
    console.log(`Knowledge base loaded: ${chunks.length} chunks, ${conceptMap?.concepts?.length || 0} concepts`);
    console.log(`Built at: ${meta?.builtAt || 'unknown'}`);
    return true;
  } catch (err) {
    console.warn('No knowledge-base.json found. Run: npm run build:knowledge');
    return false;
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────

export function search(query, topK = 6) {
  if (chunks.length === 0) return [];

  const qv = queryVector(query);

  // Score by TF-IDF cosine similarity + concept match bonus
  const queryTokens = new Set(tokenize(query));
  const scored = chunks.map(chunk => {
    let score = cosineSimilarity(qv, chunk.vector || {});

    // Boost chunks that explicitly mention relevant concepts
    const concepts = chunk.meta?.concepts || [];
    for (const concept of concepts) {
      if (queryTokens.has(concept.toLowerCase())) {
        score += 0.15;
      }
    }

    return { ...chunk, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(r => r.score > 0)
    .map(r => ({
      source: r.source,
      text: r.text,
      concepts: r.meta?.concepts || [],
      themes: r.meta?.themes || [],
      scriptureRefs: r.meta?.scriptureRefs || [],
      summary: r.meta?.summary || '',
    }));
}

// ─── Getters ──────────────────────────────────────────────────────────────────

export function getConceptMap() { return conceptMap; }
export function getMeta() { return meta; }
export function getChunkCount() { return chunks.length; }
export function isReady() { return chunks.length > 0; }
