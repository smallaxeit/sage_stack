/**
 * chunk.test.js — structure-aware chunking.
 *
 *   node --test server/lib/ingest/chunk.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { chunkText, chunkPages } from './chunk.js';

const OPTS = { chunkTarget: 200, chunkMax: 300 };

/** Every character in, every character out — chunking must never lose content. */
const assertNothingLost = (chunks, source) => {
  const norm = (s) => s.replace(/\s+/g, '');
  assert.equal(norm(chunks.join('')), norm(source), 'content was lost or duplicated');
};

describe('chunkText', () => {
  test('packs paragraphs up to the target', () => {
    const src = ['a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80)].join('\n\n');
    const chunks = chunkText(src, OPTS);
    assert.ok(chunks.length >= 1);
    assertNothingLost(chunks, src);
  });

  test('a short document yields one short chunk, never zero', () => {
    // The previous chunker dropped anything under 100 words, so a short
    // document vanished from the knowledge base with nothing reporting it.
    assert.deepEqual(chunkText('Two words.', OPTS), ['Two words.']);
  });

  test('empty input yields no chunks', () => {
    assert.deepEqual(chunkText('', OPTS), []);
    assert.deepEqual(chunkText('   \n\n  ', OPTS), []);
  });

  describe('chunkMax is a real maximum', () => {
    test('splits a long block that has only single newlines', () => {
      // The bug this covers: PDF extraction routinely emits one newline per
      // line and never a blank one, so the whole page arrived as a single
      // "paragraph" and was emitted whole. 77 of the Rx subject's 121 chunks
      // exceeded chunkMax that way, the largest at twice the cap.
      const src = Array.from({ length: 40 }, (_, i) => `Line ${i} ${'x'.repeat(40)}`).join('\n');
      assert.ok(src.length > OPTS.chunkMax * 4, 'fixture must exceed the cap several times over');

      const chunks = chunkText(src, OPTS);
      for (const c of chunks) assert.ok(c.length <= OPTS.chunkMax, `chunk of ${c.length} exceeds cap`);
      assertNothingLost(chunks, src);
    });

    test('falls back to sentence ends when there are no line breaks either', () => {
      const src = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} here.`).join(' ');
      const chunks = chunkText(src, OPTS);
      for (const c of chunks) assert.ok(c.length <= OPTS.chunkMax);
      assertNothingLost(chunks, src);
    });

    test('hard-cuts text with no boundary at all rather than exceeding the cap', () => {
      // Reached only by text with no whitespace and no sentence punctuation —
      // a base64 blob, say. Ugly, but the cap has to hold.
      const src = 'x'.repeat(1000);
      const chunks = chunkText(src, OPTS);
      for (const c of chunks) assert.ok(c.length <= OPTS.chunkMax);
      assert.equal(chunks.join(''), src);
    });

    test('a mix of splittable and unsplittable stays under the cap', () => {
      const src = ['short one', 'y'.repeat(900), 'short two'].join('\n\n');
      const chunks = chunkText(src, OPTS);
      for (const c of chunks) assert.ok(c.length <= OPTS.chunkMax, `chunk of ${c.length}`);
      assertNothingLost(chunks, src);
    });
  });
});

describe('chunkPages', () => {
  const pages = [
    { pdfPage: 0, printedPage: '1', text: 'First page paragraph.\n\nSecond paragraph here.' },
    { pdfPage: 1, printedPage: '2', text: 'Third page paragraph.' },
  ];

  test('every chunk records the page its first paragraph came from', () => {
    const chunks = chunkPages(pages, { chunkTarget: 20, chunkMax: 60 });
    assert.ok(chunks.length > 0);
    for (const c of chunks) {
      assert.equal(typeof c.pdfPage, 'number');
      assert.ok(c.printedPage, 'printed page label is what a citation shows');
    }
  });

  test('skips empty pages without losing the rest', () => {
    const withBlank = [pages[0], { pdfPage: 1, text: '   ' }, pages[1]];
    const chunks = chunkPages(withBlank, { chunkTarget: 20, chunkMax: 60 });
    assert.ok(chunks.some(c => c.text.includes('Third page')));
  });

  test('an oversized page is split, and every piece keeps its page number', () => {
    // Splitting must not cost a citation its target — a piece with no page is
    // a passage the reader cannot open to check.
    const long = [{
      pdfPage: 7, printedPage: '8',
      text: Array.from({ length: 40 }, (_, i) => `Line ${i} ${'z'.repeat(40)}`).join('\n'),
    }];
    const chunks = chunkPages(long, OPTS);

    assert.ok(chunks.length > 1, 'should have split');
    for (const c of chunks) {
      assert.ok(c.text.length <= OPTS.chunkMax, `chunk of ${c.text.length} exceeds cap`);
      assert.equal(c.pdfPage, 7);
      assert.equal(c.printedPage, '8');
    }
    assertNothingLost(chunks.map(c => c.text), long[0].text);
  });

  test('no pages yields no chunks', () => {
    assert.deepEqual(chunkPages([], OPTS), []);
    assert.deepEqual(chunkPages([{ pdfPage: 0, text: '' }], OPTS), []);
  });
});
