/**
 * ingest/render.js — PDF pages to PNG.
 *
 * The prerequisite for vision ingestion: a scanned page has no text to
 * extract, so the only way in is to look at it. ask_cooter used PyMuPDF; the
 * Node equivalent is pdf-to-img, which wraps pdfjs-dist.
 *
 * Verified on Windows against a 638-page PDF: the document opens in ~1.2s and
 * pages render at roughly 0.5s each at scale 2.
 *
 * Rendering is LAZY — an async iterator, one page at a time. A 650-page manual
 * at ~350KB per PNG is well over 200MB, and materializing that as an array
 * before the first vision call would be pointless: each page is used once and
 * discarded.
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * pdfjs ships its standard fonts as files and looks for them at a URL. Without
 * this it warns per page ("Unable to load font data at: standard_fonts/…") and
 * substitutes, which degrades exactly the text a vision model then has to read.
 */
function standardFontsUrl() {
  const dir = path.join(__dirname, '../../node_modules/pdfjs-dist/standard_fonts/');
  return new URL(`file://${dir.replace(/\\/g, '/')}`).href;
}

async function loadRenderer() {
  try {
    return await import('pdf-to-img');
  } catch {
    throw new Error(
      'Vision ingestion needs a PDF renderer.\n' +
      '  Install it:  npm --prefix server install pdf-to-img',
    );
  }
}

/**
 * Open a PDF for rendering.
 *
 * `scale` trades image size against legibility. 2 (~150 DPI) matches what
 * ask_cooter used and is enough for body text and table rules; small print in
 * a dense wiring diagram may want 3, at roughly double the bytes and therefore
 * double the vision cost.
 */
export async function openPdf(filePath, { scale = 2 } = {}) {
  const { pdf } = await loadRenderer();
  const doc = await pdf(filePath, {
    scale,
    docInitParams: { standardFontDataUrl: standardFontsUrl() },
  });
  return doc;
}

/** How many pages, without rendering any of them. */
export async function pageCount(filePath) {
  const doc = await openPdf(filePath);
  return doc.length;
}

/**
 * Yield { pdfPage, png } for a page range, rendering one at a time.
 *
 * `pdfPage` is 0-based, matching the rest of the pipeline and the store.
 */
export async function* renderPages(filePath, { start = 0, end = null, scale = 2, skip = null } = {}) {
  const doc = await openPdf(filePath, { scale });
  const last = end == null ? doc.length : Math.min(end, doc.length);

  let index = -1;
  for await (const png of doc) {
    index++;
    if (index < start) continue;
    if (index >= last) break;
    // Lets a resumed run skip pages already stored without re-rendering cost.
    if (skip && skip.has(index)) continue;
    yield { pdfPage: index, png };
  }
}
