/**
 * parse.test.js — turning a file into pages.
 *
 *   node --test server/lib/ingest/parse.test.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';

import { parseDocument, textVolume, detectIngestMode } from './parse.js';

let dir;
before(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sagestack-parse-')); });
after(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const write = async (name, body) => {
  const p = path.join(dir, name);
  await fs.writeFile(p, body);
  return p;
};

/**
 * A real .docx, not a stand-in.
 *
 * The format is a zip of XML, so building one here exercises the actual
 * unzip-and-extract path rather than a mock that would pass whatever the
 * parser happened to do.
 */
async function makeDocx(paragraphs) {
  const zip = new JSZip();

  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>');

  zip.folder('_rels').file('.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>');

  const body = paragraphs
    .map(t => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`)
    .join('');

  zip.folder('word').file('document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`);

  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('parseDocument', () => {
  test('.txt and .md come back as one unpaged page', async () => {
    const p = await write('notes.txt', 'first line\nsecond line');
    const { paged, pages } = await parseDocument(p);
    assert.equal(paged, false);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].pdfPage, null, 'no page number means no page citation');
    assert.match(pages[0].text, /second line/);
  });

  test('.csv becomes labelled rows, so a row still reads as a sentence', async () => {
    // "Torque: 35" survives chunking and embedding; a bare "35" does not.
    const p = await write('specs.csv', 'part,torque\nrear axle,35\nfront axle,60\n');
    const { pages } = await parseDocument(p);
    assert.match(pages[0].text, /part: rear axle \| torque: 35/);
    assert.match(pages[0].text, /front axle/);
  });

  test('.json is re-serialized rather than passed through raw', async () => {
    const p = await write('data.json', '{"b":2,"a":1}');
    const { pages } = await parseDocument(p);
    assert.match(pages[0].text, /"b": 2/);
  });

  describe('.docx', () => {
    test('extracts the text', async () => {
      const p = path.join(dir, 'memo.docx');
      await fs.writeFile(p, await makeDocx([
        'Quarterly Maintenance Notes',
        'Rear axle torque is 35 ft-lb.',
        'Front axle torque is 60 ft-lb.',
      ]));

      const { paged, pages } = await parseDocument(p);
      assert.equal(paged, false, 'Word stores no pagination — that is a rendering decision');
      assert.equal(pages.length, 1);
      assert.equal(pages[0].pdfPage, null);
      assert.match(pages[0].text, /Quarterly Maintenance Notes/);
      assert.match(pages[0].text, /35 ft-lb/);
      assert.match(pages[0].text, /60 ft-lb/);
    });

    test('paragraphs are separated by a blank line, so the chunker can pack on them', async () => {
      // mammoth emits one newline per paragraph. Left alone the whole document
      // arrives as a single paragraph and the chunker has to fall back to
      // cruder split points.
      const p = path.join(dir, 'paras.docx');
      await fs.writeFile(p, await makeDocx(['First paragraph.', 'Second paragraph.']));
      const { pages } = await parseDocument(p);
      assert.equal(pages[0].text, 'First paragraph.\n\nSecond paragraph.');
    });

    test('an empty document parses to empty rather than throwing', async () => {
      const p = path.join(dir, 'blank.docx');
      await fs.writeFile(p, await makeDocx([]));
      const { pages } = await parseDocument(p);
      assert.equal(pages[0].text, '');
    });

    test('the extension may be supplied separately, as uploads require', async () => {
      // An upload lands at a random temp path with no extension; only the
      // original filename knows the type.
      const p = path.join(dir, 'no-extension-here');
      await fs.writeFile(p, await makeDocx(['Body text.']));
      const { pages } = await parseDocument(p, { ext: '.docx' });
      assert.match(pages[0].text, /Body text/);
    });
  });

  test('an unsupported type is refused by name', async () => {
    const p = await write('sheet.xlsx', 'not really a spreadsheet');
    await assert.rejects(() => parseDocument(p), /Unsupported file type: \.xlsx/);
  });
});

describe('detectIngestMode', () => {
  test('a text-bearing document is text', () => {
    const pages = [{ text: 'x'.repeat(400) }, { text: 'y'.repeat(400) }];
    assert.equal(detectIngestMode(pages), 'text');
  });

  test('a scan yields almost nothing and is routed to vision', () => {
    // The failure this exists to catch: 651 pages, ~0 extractable characters,
    // and no error raised — an empty knowledge base reported as success.
    assert.equal(detectIngestMode([{ text: '' }, { text: '  ' }]), 'vision');
    assert.equal(detectIngestMode([]), 'vision');
  });

  test('textVolume ignores whitespace-only pages', () => {
    assert.equal(textVolume([{ text: ' abc ' }, { text: '   ' }, {}]), 3);
  });
});
