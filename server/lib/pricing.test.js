/**
 * pricing.test.js — what a question cost.
 *
 *   node --test server/lib/pricing.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { priceMessage, priceEmbedding, totalCost, formatUSD, PRICES } from './pricing.js';

const usage = (u) => ({
  input_tokens: 0, output_tokens: 0,
  cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...u,
});

/** Money in floating point: 3 * 0.1 is 0.30000000000000004. */
const near = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, msg || `${actual} ≉ ${expected}`);

describe('priceMessage', () => {
  test('prices the three input kinds separately, not as one sum', () => {
    // The API reports them as disjoint counts. Summing and applying the base
    // rate would overcharge a cache read by 10x.
    const c = priceMessage('claude-sonnet-5', usage({
      input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    }));
    near(c.parts.uncached, 3);        // $3/M
    near(c.parts.cacheRead, 0.3);     // a tenth of input
    near(c.parts.cacheWrite, 3.75);   // 1.25x input, 5-minute
    near(c.parts.output, 15);
    near(c.usd, 22.05);
  });

  test('a 1-hour cache write costs twice input, not 1.25x', () => {
    const c = priceMessage('claude-sonnet-5', usage({ cache_creation_input_tokens: 1_000_000 }),
      { cacheTtl: '1h' });
    near(c.parts.cacheWrite, 6);
  });

  test('reports whether the prefix was still warm', () => {
    const hit = priceMessage('claude-sonnet-5', usage({ cache_read_input_tokens: 100_000 }));
    assert.equal(hit.cacheHit, true);

    // A write means the cache had expired and was rebuilt — the usual reason a
    // question suddenly costs 10x what the last one did.
    const miss = priceMessage('claude-sonnet-5', usage({ cache_creation_input_tokens: 100_000 }));
    assert.equal(miss.cacheHit, false);
  });

  test('resolves a dated model id to its family', () => {
    const dated = priceMessage('claude-haiku-4-5-20251001', usage({ input_tokens: 1_000_000 }));
    near(dated.parts.uncached, PRICES['claude-haiku-4-5'].input);
  });

  test('an unknown model reports null rather than a made-up price', () => {
    // Showing $0.00 for a model with no price on file would read as free.
    assert.equal(priceMessage('some-future-model', usage({ input_tokens: 1000 })), null);
    assert.equal(priceMessage('claude-sonnet-5', null), null);
  });
});

describe('priceEmbedding', () => {
  test('prices a query embedding', () => {
    near(priceEmbedding('voyage-3.5', 1_000_000).usd, 0.06);
  });

  test('null for an unknown model or no tokens', () => {
    assert.equal(priceEmbedding('mystery-embed', 1000), null);
    assert.equal(priceEmbedding('voyage-3.5', 0), null);
  });
});

describe('totalCost', () => {
  test('adds up the calls one question made', () => {
    const rewrite = priceMessage('claude-haiku-4-5', usage({ input_tokens: 250, output_tokens: 30 }));
    const answer = priceMessage('claude-sonnet-5', usage({ input_tokens: 25_000, output_tokens: 800 }));
    const t = totalCost([rewrite, answer]);
    assert.equal(t.calls.length, 2);
    assert.equal(t.complete, true);
    assert.ok(Math.abs(t.usd - (rewrite.usd + answer.usd)) < 1e-12);
  });

  test('flags an incomplete total instead of under-reporting it', () => {
    // One unpriced call makes the total a floor, and the UI says so with "≥".
    const t = totalCost([priceMessage('claude-sonnet-5', usage({ input_tokens: 1000 })), null]);
    assert.equal(t.complete, false);
    assert.equal(t.calls.length, 1);
  });
});

describe('formatUSD', () => {
  test('shows cents below a penny, because $0.00 is a lie of rounding', () => {
    assert.equal(formatUSD(0.0034), '0.34¢');
    assert.equal(formatUSD(0.000012), '0.00¢');
  });

  test('dollars above a penny, with more precision under $1', () => {
    assert.equal(formatUSD(0.031), '$0.031');
    assert.equal(formatUSD(0.383), '$0.383');
    assert.equal(formatUSD(12.5), '$12.50');
  });

  test('exact zero and null', () => {
    assert.equal(formatUSD(0), '$0');
    assert.equal(formatUSD(null), null);
  });
});
