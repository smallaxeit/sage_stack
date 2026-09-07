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
 *
 * chunkMax is a real maximum. Text with no blank lines — common in PDF
 * extraction, where every line ends in a single newline — used to bypass it
 * entirely. See splitOversized.
 */

/**
 * Break one oversized block into pieces no larger than `chunkMax`.
 *
 * A blank line is the best split point, but plenty of PDF extraction never
 * emits one — every line ends in a single newline. The old code treated such a
 * block as one indivisible paragraph and emitted it whole, so chunkMax was not
 * a maximum at all: 77 of the Rx subject's 121 chunks exceeded it, median 2451
 * against a 2200 cap, largest 4414. An oversized chunk costs tokens on every
 * question that retrieves it, and blunts the embedding — a whole page reduced
 * to a single vector matches everything and nothing.
 *
 * Boundaries are tried in order of how much structure they preserve: line
 * breaks, then sentence ends, then a hard cut. The hard cut is reached only by
 * text with neither a line break nor sentence punctuation for thousands of
 * characters, but it has to exist or the guarantee is not a guarantee.
 *
 * Never discards content: every character of the input appears in the output.
 */
function splitOversized(text, chunkMax) {
  if (text.length <= chunkMax) return [text];

  const BOUNDARIES = [
    { pattern: /\n+/, join: '\n' },
    { pattern: /(?<=[.!?])\s+/, join: ' ' },
  ];

  for (const { pattern, join } of BOUNDARIES) {
    const parts = text.split(pattern).filter(Boolean);
    if (parts.length < 2) continue;

    const out = [];
    let buf = [];
    let size = 0;
    for (const part of parts) {
      if (size + part.length > chunkMax && buf.length) {
        out.push(buf.join(join));
        buf = [];
        size = 0;
      }
      buf.push(part);
      size += part.length + join.length;
    }
    if (buf.length) out.push(buf.join(join));

    // One part can still be too long on its own — a 5,000-character line with
    // no sentence end. Recurse so the next weaker boundary gets a turn.
    const settled = out.flatMap(piece =>
      piece.length > chunkMax ? splitOversized(piece, chunkMax) : [piece]);
    if (settled.every(piece => piece.length <= chunkMax)) return settled;
  }

  const out = [];
  for (let i = 0; i < text.length; i += chunkMax) out.push(text.slice(i, i + chunkMax));
  return out;
}

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
    // An oversized paragraph is split on the strongest boundary it still has,
    // rather than emitted whole. Emitting it whole was the original intent, but
    // it quietly made chunkMax advisory.
    if (para.length >= chunkMax) {
      flush();
      chunks.push(...splitOversized(para, chunkMax));
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
      // Every piece keeps the page it came from, so citations still resolve.
      for (const piece of splitOversized(para.text, chunkMax)) {
        chunks.push({ text: piece, pdfPage: para.pdfPage, printedPage: para.printedPage });
      }
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
