/**
 * ingest/parse.js — page-aware document parsing.
 *
 * The older parser.js flattens a PDF into one string, which makes a page
 * citation impossible: you can retrieve the right passage but not tell the
 * reader where to look. Every chunk here carries the page it came from, so the
 * UI can link a citation straight to that page of the original file — the
 * behavior ask_cooter gets from its per-page ingestion.
 *
 * Two page numbers are kept, for the reason ask_cooter documents: `pdfPage` is
 * the position in the file (0-based internally, shown 1-based) and is what a
 * viewer jumps to; `printedPage` is the label printed on the page itself. They
 * differ wherever there is front matter.
 */

import fs from 'fs/promises';
import path from 'path';
import pdfParse from 'pdf-parse';
import { parse as csvParse } from 'csv-parse/sync';

/** Page labels look like "3-14", "iv", or a bare number, alone on a line. */
const PAGE_LABEL = /^\s*((?:[0-9]+[-–][0-9]+)|(?:[ivxlcdm]{1,7})|(?:[0-9]{1,4}))\s*$/i;

/**
 * Guess the printed page label from the page's own text: a short line at the
 * very top or very bottom that looks like a page number. Returns null when
 * nothing convincing is there — a wrong label is worse than none.
 */
function guessPrintedPage(text) {
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  for (const candidate of [lines[lines.length - 1], lines[0]]) {
    if (candidate && candidate.length <= 12) {
      const m = candidate.match(PAGE_LABEL);
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * Parse a PDF into per-page text.
 *
 * pdf-parse exposes a `pagerender` hook that is called once per page; the
 * default joins every page into one blob. Overriding it is the supported way
 * to keep the page boundaries.
 */
async function parsePdfPages(buffer) {
  const pages = [];

  await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent({
        normalizeWhitespace: true,
        disableCombineTextItems: false,
      });

      // Reconstruct lines by tracking vertical position: PDF text items carry
      // no line breaks, so a naive join runs every line together.
      let lastY = null;
      let line = [];
      const lines = [];
      for (const item of content.items) {
        const y = item.transform?.[5];
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 1) {
          lines.push(line.join(''));
          line = [];
        }
        line.push(item.str);
        if (y !== undefined) lastY = y;
      }
      if (line.length) lines.push(line.join(''));

      const text = lines.join('\n').replace(/[ \t]+\n/g, '\n').trim();
      pages.push(text);
      return text;
    },
  });

  return pages.map((text, i) => ({
    pdfPage: i,
    printedPage: guessPrintedPage(text),
    text,
  }));
}

/**
 * Parse any supported document into pages.
 *
 * Non-paged formats (.txt, .md, .json, .csv) return a single page with
 * pdfPage null, so downstream code has one shape to handle.
 */
export async function parseDocument(filePath, { ext: explicitExt } = {}) {
  // Prefer an explicitly supplied extension: an upload lives at a random temp
  // path with no extension, and only the original filename knows the type.
  const ext = String(explicitExt ?? path.extname(filePath)).toLowerCase();
  const raw = await fs.readFile(filePath);

  switch (ext) {
    case '.pdf': {
      const pages = await parsePdfPages(raw);
      return { paged: true, pages };
    }
    case '.txt':
    case '.md':
      return { paged: false, pages: [{ pdfPage: null, printedPage: null, text: raw.toString('utf-8') }] };
    case '.json':
      return {
        paged: false,
        pages: [{ pdfPage: null, printedPage: null, text: JSON.stringify(JSON.parse(raw.toString('utf-8')), null, 2) }],
      };
    case '.csv': {
      const records = csvParse(raw, { columns: true, skip_empty_lines: true });
      const text = records.map(r => Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(' | ')).join('\n');
      return { paged: false, pages: [{ pdfPage: null, printedPage: null, text }] };
    }
    default:
      throw new Error(`Unsupported file type: ${ext || '(none)'}`);
  }
}

/** Total extractable characters — used to decide whether a PDF is a scan. */
export function textVolume(pages) {
  return pages.reduce((n, p) => n + (p.text ? p.text.trim().length : 0), 0);
}

/**
 * Decide whether a document needs vision ingestion.
 *
 * A scanned PDF returns almost nothing from text extraction — ask_cooter's
 * 651-page manual yielded ~0 characters. Rather than storing an empty
 * knowledge base and calling it success, detect it and say so.
 */
export function detectIngestMode(pages, { minCharsPerPage = 100 } = {}) {
  if (pages.length === 0) return 'vision';
  const perPage = textVolume(pages) / pages.length;
  return perPage < minCharsPerPage ? 'vision' : 'text';
}
