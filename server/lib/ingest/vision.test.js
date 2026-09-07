/**
 * vision.test.js — page extraction, retry and fallback.
 *
 *   node --test server/lib/ingest/vision.test.js
 *
 * No network and no PDF: the model client is a double and the page is a stub
 * buffer. The retry behavior is the part worth testing, because it is what
 * makes a several-hundred-page run finish at all.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildVisionPrompt, extractPage, estimateVisionCost } from './vision.js';

const profile = { name: 'Test Manual', slug: 'test' };
const png = Buffer.from('fake-png-bytes');
const noSleep = async () => {};

const reply = (obj) => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  usage: { input_tokens: 1500, output_tokens: 800 },
});

/** Client double: `script` is consumed one entry per call. */
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push({ model: req.model, content: req.messages[0].content });
        const next = script.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

const GOOD = () => reply({
  printedPage: '3-14', section: 'FRONT BRAKE', markdown: '## Torque\n| bolt | 25 ft-lb |',
  isBlank: false, componentTags: ['front brake'], specs: [{ name: 'caliper bolt', value: '25', unit: 'ft-lb' }],
});

describe('buildVisionPrompt', () => {
  test('demands transcription, not summary, and forbids guessing', () => {
    const p = buildVisionPrompt(profile, '  "specs": "torque values"');
    assert.match(p, /transcription task, not a summary/i);
    assert.match(p, /Do not paraphrase/i);
    assert.match(p, /EXACTLY as printed/);
    assert.match(p, /\[illegible\]/);
    assert.match(p, /"specs": "torque values"/, 'subject extract fields must reach the prompt');
  });

  test('tables are called out as the thing not to drop', () => {
    // A dropped table row is a fact silently lost, and tables are usually the
    // most valuable content on a manual page.
    assert.match(buildVisionPrompt(profile, ''), /markdown table[\s\S]*dropped row/i);
  });
});

describe('extractPage', () => {
  test('returns a normalized page and reports usage', async () => {
    const client = fakeClient([GOOD()]);
    const p = await extractPage({ client, profile, png, pdfPage: 41, sleep: noSleep });

    assert.equal(p.pdfPage, 41);
    assert.equal(p.printedPage, '3-14');
    assert.equal(p.section, 'FRONT BRAKE');
    assert.deepEqual(p.componentTags, ['front brake']);
    assert.deepEqual(p.extras.specs, [{ name: 'caliper bolt', value: '25', unit: 'ft-lb' }]);
    assert.equal(p.recovered, false);
    assert.equal(p.usage.input_tokens, 1500);

    // The image must actually be sent.
    const [img, txt] = client.calls[0].content;
    assert.equal(img.type, 'image');
    assert.equal(img.source.media_type, 'image/png');
    assert.equal(txt.type, 'text');
  });

  test('retries a transient failure on the same model', async () => {
    const client = fakeClient([new Error('529 overloaded'), GOOD()]);
    const p = await extractPage({ client, profile, png, pdfPage: 0, sleep: noSleep });
    assert.equal(p.recovered, false, 'same model, so not a fallback');
    assert.equal(client.calls.length, 2);
  });

  test('falls back to the other model tier when one keeps failing', async () => {
    // The reason this exists: a page that trips a content filter on one model
    // often succeeds on the other, and re-running a whole ingest for a handful
    // of pages is the expensive outcome.
    const client = fakeClient([
      new Error('content filter'), new Error('content filter'), GOOD(),
    ]);
    const p = await extractPage({
      client, profile, png, pdfPage: 7,
      model: 'claude-sonnet-5', fallbackModel: 'claude-opus-5', sleep: noSleep,
    });
    assert.equal(p.model, 'claude-opus-5');
    assert.equal(p.recovered, true);
    assert.deepEqual(client.calls.map(c => c.model),
      ['claude-sonnet-5', 'claude-sonnet-5', 'claude-opus-5']);
  });

  test('does not retry a failure that cannot fix itself', async () => {
    const client = fakeClient([new Error('invalid x-api-key'), GOOD(), GOOD(), GOOD()]);
    await assert.rejects(
      () => extractPage({ client, profile, png, pdfPage: 2, sleep: noSleep }),
      /invalid x-api-key/,
    );
    // Exactly one call: it did not retry, and did not try the other model
    // either, because neither would have helped.
    assert.equal(client.calls.length, 1);
  });

  test('a refusal is treated as a page failure, not a silent empty page', async () => {
    const refusal = { stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [], usage: {} };
    const client = fakeClient([refusal, refusal, refusal, refusal]);
    await assert.rejects(
      () => extractPage({ client, profile, png, pdfPage: 5, sleep: noSleep }),
      /page 6:.*refusal/,
    );
  });

  test('recovers a JSON object from a chatty reply', async () => {
    const client = fakeClient([{
      content: [{ type: 'text', text: 'Here is the page:\n```json\n{"markdown":"body","isBlank":false}\n```\nHope that helps.' }],
      usage: {},
    }]);
    const p = await extractPage({ client, profile, png, pdfPage: 0, sleep: noSleep });
    assert.equal(p.markdown, 'body');
  });

  test('the error names the page, so a failed run says which to retry', async () => {
    const client = fakeClient([new Error('529'), new Error('529'), new Error('529'), new Error('529')]);
    try {
      await extractPage({ client, profile, png, pdfPage: 118, sleep: noSleep });
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.pdfPage, 118);
      assert.match(err.message, /page 119/);   // 1-based for humans
    }
  });
});

describe('estimateVisionCost', () => {
  test('scales with pages and model', () => {
    const sonnet = estimateVisionCost(650, { model: 'claude-sonnet-5' });
    const opus   = estimateVisionCost(650, { model: 'claude-opus-5' });
    assert.ok(sonnet.usd > 0);
    assert.ok(opus.usd > sonnet.usd, 'opus must estimate higher');
    assert.ok(Math.abs(sonnet.perPage - sonnet.usd / 650) < 1e-9);
  });

  test('deliberately over-estimates', () => {
    // Measured on real pages: ~$0.0105/page on sonnet. The estimate should sit
    // above that — the useful error here is being pleasantly surprised.
    assert.ok(estimateVisionCost(1, { model: 'claude-sonnet-5' }).usd > 0.0105);
  });
});
