/**
 * ingest.test.js — the decisions ingestDocument makes before it does any work.
 *
 *   node --test server/lib/ingest/ingest.test.js
 *
 * The routing decision — text, vision, or detect-and-choose — had no coverage
 * at all, which is how `ingest.mode: "auto"` shipped detecting a scan and then
 * refusing it. That made auto behave exactly like text.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { ingestDocument, dedupeChunks, safeFilename } from './index.js';

let dir;
before(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagestack-ingest-')); });
after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

/** Enough store for ingest to run against without a database. */
const fakeStore = () => ({
  chunks: [],
  async initSubject() {},
  async getSubjectMeta() { return null; },
  async upsertChunks(_slug, rows) { this.chunks.push(...rows); return rows.length; },
});

const profile = (over = {}) => ({
  slug: 'demo',
  name: 'Demo',
  voice: 'v',
  ingest: { mode: 'auto', chunkTarget: 1400, chunkMax: 2200, keepOriginal: true, ...(over.ingest || {}) },
  embed: { driver: 'voyage', model: 'voyage-3.5', dim: 1024 },
  extract: {},
  ...over,
});

describe('choosing how to read a document', () => {
  test('only a PDF can be treated as a scan', async () => {
    // Scan detection measures text volume, which says nothing about format. A
    // near-empty .txt is just a near-empty document — handing it to vision
    // would fail inside the PDF renderer, far from the actual problem.
    const file = path.join(dir, 'almost-empty.txt');
    await fs.writeFile(file, '   \n');

    await assert.rejects(
      () => ingestDocument({
        profile: profile(), store: fakeStore(), embedder: null, analysisClient: null,
        filePath: file, keepOriginal: false,
      }),
      /produced no chunks/,
      'should fail as an empty document, not as a scan',
    );
  });

  test('a text document with content ingests without reaching for vision', async () => {
    const file = path.join(dir, 'notes.txt');
    await fs.writeFile(file, Array.from({ length: 30 }, (_, i) =>
      `Paragraph ${i}. Some genuine content that carries enough text to chunk.`).join('\n\n'));

    const store = fakeStore();
    const result = await ingestDocument({
      profile: profile(), store, embedder: null, analysisClient: null,
      filePath: file, keepOriginal: false,
    });

    assert.ok(result.chunks > 0, 'stored chunks');
    assert.ok(store.chunks.length > 0);
    assert.equal(store.chunks[0].pdfPage, null, 'a .txt carries no page number');
    // No embedder was supplied, so it must say the document is unsearchable
    // rather than reporting plain success.
    assert.ok(result.warnings.some(w => /not searchable|embed/i.test(w)),
      `expected a warning about missing embeddings, got ${JSON.stringify(result.warnings)}`);
  });
});

describe('dedupeChunks', () => {
  test('drops exact repeats and counts them', () => {
    // The theology import arrived with 434 exact duplicates — 8% — each one
    // silently consuming a retrieval slot.
    const { kept, removed } = dedupeChunks([
      { text: 'the same passage' },
      { text: 'the same passage' },
      { text: 'a different passage' },
    ]);
    assert.equal(kept.length, 2);
    assert.equal(removed, 1);
  });

  test('matches across whitespace differences, since extraction reflows text', () => {
    const { kept, removed } = dedupeChunks([
      { text: 'one two three' },
      { text: 'one  two\nthree' },
    ]);
    assert.equal(kept.length, 1);
    assert.equal(removed, 1);
  });

  test('keeps the first occurrence, not the last', () => {
    const { kept } = dedupeChunks([
      { text: 'dup', id: 'first' },
      { text: 'dup', id: 'second' },
    ]);
    assert.equal(kept[0].id, 'first');
  });

  test('drops chunks that are empty once normalized', () => {
    const { kept } = dedupeChunks([{ text: '   \n ' }, { text: 'real' }]);
    assert.deepEqual(kept.map(k => k.text), ['real']);
  });
});

describe('safeFilename', () => {
  test('reduces a path to its basename', () => {
    assert.equal(safeFilename('/etc/passwd'), 'passwd');
    assert.equal(safeFilename('..\\..\\windows\\system32\\config'), 'config');
  });

  test('refuses names that resolve to a directory', () => {
    for (const bad of ['', '   ', '.', '..']) {
      assert.throws(() => safeFilename(bad), /Invalid filename/);
    }
  });
});
