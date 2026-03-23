/**
 * embeddings.js
 *
 * Generates and stores Voyage AI embeddings for chunks.
 * Uses voyage-3 — optimized for semantic search across diverse/multilingual text.
 *
 * Storage: Supabase chunks.embedding (vector(1024))
 * Search:  pgvector cosine similarity via Supabase RPC
 */

import { supabase } from './supabase.js';

const VOYAGE_API = 'https://api.voyageai.com/v1/embeddings';

async function voyageEmbed(texts, inputType = 'document') {
  if (!process.env.VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY not set');
  const res = await fetch(VOYAGE_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, input: texts, input_type: inputType }),
  });
  if (!res.ok) throw new Error(`Voyage API error: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data.map(d => d.embedding);
}

const MODEL = 'voyage-3';
const DIMENSIONS = 1024;
const BATCH_SIZE = 128; // Voyage supports up to 128 texts per request

/**
 * Embed a single query string for search (not stored)
 */
export async function embedQuery(text) {
  const embeddings = await voyageEmbed([text], 'query');
  return embeddings[0];
}

/**
 * Embed and store all chunks that don't have embeddings yet.
 * Reads from Supabase chunks table, writes back to embedding column.
 */
export async function buildEmbeddings(onProgress) {
  if (!supabase) throw new Error('Supabase not configured');

  // Get chunks missing embeddings
  const { data: chunks, error } = await supabase
    .from('chunks')
    .select('id, source, chunk_index, text')
    .is('embedding', null)
    .order('chunk_index');

  if (error) throw error;
  if (!chunks || chunks.length === 0) {
    console.log('  All chunks already have embeddings.');
    return 0;
  }

  console.log(`  ${chunks.length} chunks need embeddings...`);
  let done = 0;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map(c => c.text);

    const embeddings = await voyageEmbed(texts, 'document');

    // Write embeddings back to Supabase
    const updates = batch.map((chunk, j) => ({
      id: chunk.id,
      embedding: embeddings[j],
    }));

    for (const update of updates) {
      await supabase
        .from('chunks')
        .update({ embedding: update.embedding })
        .eq('id', update.id);
    }

    done += batch.length;
    if (onProgress) onProgress(done, chunks.length);
    console.log(`  Embedded ${done}/${chunks.length}`);
  }

  return done;
}

/**
 * Search using pgvector cosine similarity.
 * Falls back to TF-IDF if embeddings not available.
 */
export async function searchByEmbedding(query, topK = 10) {
  if (!supabase) return null;

  try {
    const queryEmbedding = await embedQuery(query);

    const { data, error } = await supabase.rpc('match_chunks', {
      query_embedding: queryEmbedding,
      match_count: topK,
    });

    if (error) {
      console.warn('[embeddings] pgvector search failed, falling back to TF-IDF:', error.message);
      return null;
    }

    return data.map(r => ({
      source: r.source,
      chunk_index: r.chunk_index,
      text: r.text,
      concepts: r.concepts || [],
      themes: r.themes || [],
      scriptureRefs: r.scripture_refs || [],
      summary: r.summary || '',
      score: r.similarity,
    }));
  } catch (err) {
    console.warn('[embeddings] Search error, falling back to TF-IDF:', err.message);
    return null;
  }
}
