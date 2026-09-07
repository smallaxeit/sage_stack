/**
 * models.test.js — the model registry.
 *
 *   node --test server/lib/models.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { modelFor, purposeConfig, modelConfig, checkModelPricing } from './models.js';
import { PRICES, EMBED_PRICES, priceMessage } from './pricing.js';

describe('purposes', () => {
  test('every job the code asks for is configured', () => {
    // If a purpose is renamed in config without updating its caller, the caller
    // throws at import time. Naming them here makes that a test failure instead.
    for (const purpose of ['chat', 'rewrite', 'analysis', 'conceptMap', 'vision', 'embed']) {
      assert.ok(modelFor(purpose), `${purpose} has no model`);
    }
  });

  test('an unknown purpose names the ones that exist', () => {
    assert.throws(() => modelFor('summarizer'), /Unknown model purpose.*chat/s);
  });

  test('carries more than the model id where a purpose needs it', () => {
    assert.equal(typeof purposeConfig('chat').maxTokens, 'number');
    assert.equal(typeof purposeConfig('embed').dim, 'number');
    // Vision falls back to a stronger model on a page the first one cannot read.
    assert.ok(purposeConfig('vision').fallback);
  });

  test('an env var overrides for a one-off run', () => {
    const before = process.env.SAGESTACK_MODEL_REWRITE;
    process.env.SAGESTACK_MODEL_REWRITE = 'claude-opus-5';
    try {
      assert.equal(modelFor('rewrite'), 'claude-opus-5');
      // Only the model; the rest of the purpose is untouched.
      assert.equal(purposeConfig('rewrite').maxTokens, modelConfig().purposes.rewrite.maxTokens);
    } finally {
      if (before === undefined) delete process.env.SAGESTACK_MODEL_REWRITE;
      else process.env.SAGESTACK_MODEL_REWRITE = before;
    }
  });

  test('camelCase purposes map to SCREAMING_SNAKE env vars', () => {
    const before = process.env.SAGESTACK_MODEL_CONCEPT_MAP;
    process.env.SAGESTACK_MODEL_CONCEPT_MAP = 'claude-haiku-4-5';
    try {
      assert.equal(modelFor('conceptMap'), 'claude-haiku-4-5');
    } finally {
      if (before === undefined) delete process.env.SAGESTACK_MODEL_CONCEPT_MAP;
      else process.env.SAGESTACK_MODEL_CONCEPT_MAP = before;
    }
  });
});

describe('pricing is one table', () => {
  test('pricing.js reads the config rather than its own copy', () => {
    // Two price tables is how the vision estimator ended up quoting Sonnet at
    // $2/$10 while the chat path priced the same model at $3/$15.
    assert.equal(PRICES, modelConfig().pricing.text);
    assert.equal(EMBED_PRICES, modelConfig().pricing.embedding);
  });

  test('every configured model has a price', () => {
    assert.deepEqual(checkModelPricing({ warn() {} }), []);
  });

  test('the same model costs the same wherever it is priced', () => {
    const model = modelFor('vision');
    const a = priceMessage(model, { input_tokens: 1_000_000, output_tokens: 0 });
    assert.equal(a.parts.uncached, PRICES[model].input);
  });
});
