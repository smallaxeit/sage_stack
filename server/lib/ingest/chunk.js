/**
 * ingest/chunk.js — structure-aware chunking.
 *
 * Splits on paragraph boundaries and packs up to a character target, keeping
 * tables and procedure steps intact within a chunk where possible. Character
 * targets rather than word counts because they map predictably onto tokens
 * (~4 chars/token) and onto embedding model limits.
 *
 * IMPORTANT: this never discards content. The previous chunker dropped any
 * chunk under 100 words, which meant a short document produced ZERO chunks and
 * vanished from the knowledge base silently. A short document here yields one
 * short chunk.
 */

/** Split text into chunks. Never returns [] for non-empty input. */
export function chunkText(text, { chunkTarget = 1400, chunkMax = 2200 } = {}) {
  const normalised = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalised) return [];

  const paragraphs = normalised.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [normalised];

  const chunks = [];
  let buf = [];
  let size = 0;

  const flush = () => {
    if (buf.length) { chunks.push(buf.join('\n\n')); buf = []; size = 0; }
  };

  for (const para of paragraphs) {
    // An oversized single paragraph (a big table, an unbroken page of text)
    // becomes its own chunk rather than being force-split mid-structure.
    if (para.length >= chunkMax) {
      flush();
      chunks.push(para);
      continue;
    }
    if (size + para.length > chunkMax && buf.length) flush();

    buf.push(para);
    size += para.length + 2;

    if (size >= chunkTarget) flush();
  }
  flush();

  return chunks;
}

/** Rough token estimate — 4 chars per token is close enough for budgeting. */
export function approxTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}
