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
  const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [normalized];

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

/**
 * Chunk a paged document, recording where each chunk starts.
 *
 * Chunks are packed ACROSS page boundaries rather than reset at each page.
 * Prose runs over page breaks, and resetting would produce a torrent of tiny
 * fragments for a 600-page book. Each chunk records the page its first
 * paragraph came from, which is what a citation links to.
 *
 * (A service manual is the opposite case -- its pages are self-contained
 * units -- which is what vision ingestion will handle in Phase 4.)
 */
export function chunkPages(pages, { chunkTarget = 1400, chunkMax = 2200 } = {}) {
  // Flatten to paragraphs, each remembering its page.
  const paras = [];
  for (const page of pages) {
    const normalized = String(page.text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!normalized) continue;
    for (const p of normalized.split(/\n{2,}/).map(s => s.trim()).filter(Boolean)) {
      paras.push({ text: p, pdfPage: page.pdfPage ?? null, printedPage: page.printedPage ?? null });
    }
  }
  if (paras.length === 0) return [];

  const chunks = [];
  let buf = [];
  let size = 0;
  let start = null;

  const flush = () => {
    if (!buf.length) return;
    chunks.push({
      text: buf.join('\n\n'),
      pdfPage: start.pdfPage,
      printedPage: start.printedPage,
    });
    buf = [];
    size = 0;
    start = null;
  };

  for (const para of paras) {
    if (para.text.length >= chunkMax) {
      flush();
      chunks.push({ text: para.text, pdfPage: para.pdfPage, printedPage: para.printedPage });
      continue;
    }
    if (size + para.text.length > chunkMax && buf.length) flush();

    if (!buf.length) start = para;
    buf.push(para.text);
    size += para.text.length + 2;

    if (size >= chunkTarget) flush();
  }
  flush();

  return chunks;
}
