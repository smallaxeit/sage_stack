/**
 * embed.test.js — embedder interface, the Voyage driver, and the mismatch guard.
 *
 *   node --test server/lib/embed/embed.test.js
 *
 * The Voyage driver is tested against an injected fetch, so the suite makes no
 * network calls and needs no API key. The local driver's construction is tested
 * (dimension bookkeeping); actually running a model would download weights, so
 * that is left to a manual check.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createEmbedder, assertEmbedderMatchesSubject, l2norm, normalize, EMBED_DRIVERS } from './index.js';
import { createVoyageEmbedder } from './voyage.js';
import { createLocalEmbedder, KNOWN_DIMS } from './local.js';

const DIM = 1024;
const vec = (seed, dim = DIM) => Array.from({ length: dim }, (_, i) => Math.sin(seed + i) / 2);

/** A fake Voyage endpoint. Records calls, returns well-formed responses. */
function fakeVoyage({ dim = DIM, failTimes = 0, status = 429, shuffle = false } = {}) {
  const calls = [];
  let failsLeft = failTimes;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    if (failsLeft > 0) {
      failsLeft--;
      return { ok: false, status, text: async () => 'rate limited' };
    }
    let data = body.input.map((t, i) => ({ index: i, embedding: vec(t.length + i, dim) }));
    if (shuffle) data = data.slice().reverse(); // Voyage does not promise order
    return { ok: true, json: async () => ({ data }) };
  };
  return { fetch, calls };
}

const noSleep = async () => {};

describe('createEmbedder', () => {
  test('defaults to voyage', () => {
    const e = createEmbedder({ apiKey: 'k' });
    assert.equal(e.driver, 'voyage');
    assert.equal(e.model, 'voyage-3.5');
    assert.equal(e.dim, 1024);
  });

  test('rejects an unknown driver', () => {
    assert.throws(() => createEmbedder({ driver: 'openai' }), /Unknown EMBED_DRIVER/);
  });

  test('every advertised driver constructs', () => {
    assert.deepEqual(EMBED_DRIVERS, ['voyage', 'local']);
    assert.equal(createEmbedder({ driver: 'voyage', apiKey: 'k' }).driver, 'voyage');
    assert.equal(createEmbedder({ driver: 'local' }).driver, 'local');
  });

  test('accepts a subject profile embed block directly', () => {
    const e = createEmbedder({ driver: 'voyage', model: 'voyage-3.5', dim: 512, apiKey: 'k' });
    assert.equal(e.dim, 512);
  });
});

describe('voyage driver', () => {
  test('embeds documents and preserves input order', async () => {
    const { fetch, calls } = fakeVoyage();
    const e = createVoyageEmbedder({ apiKey: 'k', fetch });
    const out = await e.embedDocuments(['one', 'two', 'three']);
    assert.equal(out.length, 3);
    assert.equal(out[0].length, DIM);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.input_type, 'document');
    assert.deepEqual(calls[0].body.input, ['one', 'two', 'three']);
  });

  test('reorders by the index field rather than trusting response order', async () => {
    const { fetch } = fakeVoyage({ shuffle: true });
    const e = createVoyageEmbedder({ apiKey: 'k', fetch });
    const out = await e.embedDocuments(['aaaa', 'bb', 'c']);
    // Expected vectors are derived from text length + position, so a wrong
    // order produces different numbers.
    assert.deepEqual(out[0], vec('aaaa'.length + 0));
    assert.deepEqual(out[2], vec('c'.length + 2));
  });

  test('queries use input_type=query', async () => {
    const { fetch, calls } = fakeVoyage();
    const e = createVoyageEmbedder({ apiKey: 'k', fetch });
    const q = await e.embedQuery('what is grace');
    assert.equal(q.length, DIM);
    assert.equal(calls[0].body.input_type, 'query');
  });

  test('batches at 128', async () => {
    const { fetch, calls } = fakeVoyage();
    const e = createVoyageEmbedder({ apiKey: 'k', fetch });
    const texts = Array.from({ length: 300 }, (_, i) => `t${i}`);
    const out = await e.embedDocuments(texts);
    assert.equal(out.length, 300);
    assert.deepEqual(calls.map(c => c.body.input.length), [128, 128, 44]);
  });

  test('reports progress across batches', async () => {
    const { fetch } = fakeVoyage();
    const e = createVoyageEmbedder({ apiKey: 'k', fetch });
    const seen = [];
    await e.embedDocuments(Array.from({ length: 200 }, (_, i) => `t${i}`),
      { onProgress: p => seen.push(p.done) });
    assert.deepEqual(seen, [128, 200]);
  });

  test('retries a 429 then succeeds', async () => {
    const { fetch, calls } = fakeVoyage({ failTimes: 2 });
    const e = createVoyageEmbedder({ apiKey: 'k', fetch, sleep: noSleep });
    const out = await e.embedDocuments(['x']);
    assert.equal(out.length, 1);
    assert.equal(calls.length, 3, 'two failures then one success');
  });

  test('retries 5xx but not 400', async () => {
    const server = fakeVoyage({ failTimes: 1, status: 503 });
    const e1 = createVoyageEmbedder({ apiKey: 'k', fetch: server.fetch, sleep: noSleep });
    assert.equal((await e1.embedDocuments(['x'])).length, 1);

    const bad = fakeVoyage({ failTimes: 99, status: 400 });
    const e2 = createVoyageEmbedder({ apiKey: 'k', fetch: bad.fetch, sleep: noSleep });
    await assert.rejects(() => e2.embedDocuments(['x']), /Voyage API error: 400/);
    assert.equal(bad.calls.length, 1, 'a 400 must not be retried');
  });

  test('gives up after maxRetries', async () => {
    const { fetch, calls } = fakeVoyage({ failTimes: 99 });
    const e = createVoyageEmbedder({ apiKey: 'k', fetch, sleep: noSleep, maxRetries: 2 });
    await assert.rejects(() => e.embedDocuments(['x']), /Voyage API error: 429/);
    assert.equal(calls.length, 3, 'initial attempt plus two retries');
  });

  test('rejects a dimension the model cannot produce', () => {
    assert.throws(() => createVoyageEmbedder({ apiKey: 'k', dim: 999 }), /supports dimensions/);
    assert.equal(createVoyageEmbedder({ apiKey: 'k', dim: 512 }).dim, 512);
  });

  test('catches a wrong-size vector from the API', async () => {
    const { fetch } = fakeVoyage({ dim: 512 }); // server returns 512, we want 1024
    const e = createVoyageEmbedder({ apiKey: 'k', fetch });
    await assert.rejects(() => e.embedDocuments(['x']), /returned 512 dims, expected 1024/);
  });

  test('a missing key fails with a useful message, not a 401', async () => {
    const e = createVoyageEmbedder({ apiKey: '', fetch: fakeVoyage().fetch });
    await assert.rejects(() => e.embedQuery('x'), /VOYAGE_API_KEY is not set[\s\S]*EMBED_DRIVER=local/);
  });

  test('embedding nothing makes no API call', async () => {
    const { fetch, calls } = fakeVoyage();
    const e = createVoyageEmbedder({ apiKey: 'k', fetch });
    assert.deepEqual(await e.embedDocuments([]), []);
    assert.equal(calls.length, 0);
  });
});

describe('local driver', () => {
  test('infers the dimension from a known model', () => {
    const e = createLocalEmbedder({});
    assert.equal(e.model, 'Xenova/all-MiniLM-L6-v2');
    assert.equal(e.dim, 384);
    assert.equal(createLocalEmbedder({ model: 'Xenova/bge-base-en-v1.5' }).dim, 768);
  });

  test('an unknown model requires an explicit dim', () => {
    assert.throws(() => createLocalEmbedder({ model: 'nobody/unknown' }), /Unknown local embedding model/);
    assert.equal(createLocalEmbedder({ model: 'nobody/unknown', dim: 512 }).dim, 512);
  });

  test('rejects a dim that contradicts a known model', () => {
    assert.throws(() => createLocalEmbedder({ model: 'Xenova/all-MiniLM-L6-v2', dim: 1024 }),
      /produces 384 dims, not 1024/);
  });

  test('known dims are all plausible', () => {
    for (const [model, d] of Object.entries(KNOWN_DIMS)) {
      assert.ok(Number.isInteger(d) && d > 0, `${model} has a bad dim`);
    }
  });
});

describe('the mismatch guard', () => {
  const embedder = { driver: 'voyage', model: 'voyage-3.5', dim: 1024 };

  test('passes when model and dim agree', () => {
    assert.equal(
      assertEmbedderMatchesSubject(embedder, { slug: 's', embedModel: 'voyage-3.5', dim: 1024 }),
      true,
    );
  });

  test('refuses a dimension mismatch', () => {
    assert.throws(
      () => assertEmbedderMatchesSubject(embedder, { slug: 's', embedModel: 'voyage-3.5', dim: 768 }),
      /dimension mismatch[\s\S]*768 dims[\s\S]*produces 1024/,
    );
  });

  test('refuses a model mismatch even at the same dimension', () => {
    // voyage-3 and voyage-3.5 are both 1024-dim. This is the dangerous case:
    // nothing errors naturally, the search just silently returns nonsense.
    assert.throws(
      () => assertEmbedderMatchesSubject(embedder, { slug: 'theology', embedModel: 'voyage-3', dim: 1024 }),
      /model mismatch[\s\S]*plausible nonsense/,
    );
  });

  test('refuses a subject that does not record its model, unless told to allow it', () => {
    const legacy = { slug: 'imported', embedModel: null, dim: 1024 };
    assert.throws(() => assertEmbedderMatchesSubject(embedder, legacy), /does not record which model/);
    assert.equal(assertEmbedderMatchesSubject(embedder, legacy, { allowUnknownModel: true }), true);
    // Dimension is still enforced in that mode.
    assert.throws(
      () => assertEmbedderMatchesSubject(embedder, { ...legacy, dim: 384 }, { allowUnknownModel: true }),
      /dimension mismatch/,
    );
  });

  test('requires subject metadata', () => {
    assert.throws(() => assertEmbedderMatchesSubject(embedder, null), /no subject metadata/);
  });
});

describe('vector helpers', () => {
  test('l2norm and normalize', () => {
    assert.equal(l2norm([3, 4]), 5);
    const v = normalize([3, 4]);
    assert.ok(Math.abs(l2norm(v) - 1) < 1e-12);
    assert.deepEqual(normalize([0, 0]), [0, 0], 'a zero vector is left alone');
  });
});
