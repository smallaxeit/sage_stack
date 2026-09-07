/**
 * prefer.test.js — soft filtering of retrieval results.
 *
 *   node --test server/lib/prefer.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { termsFrom, matches, preferRank, availableTerms } from './prefer.js';

const chunk = (drugs, score = 0.5, id = 'c') => ({ id, score, text: 't', extras: { drugs } });

describe('termsFrom', () => {
  test('reads plain strings', () => {
    assert.deepEqual([...termsFrom(chunk(['Aspirin', 'warfarin']), 'drugs')].sort(),
      ['aspirin', 'warfarin']);
  });

  test('reads objects, taking every name on them', () => {
    // Extraction records {generic, brand, drugClass}; a reader may type any.
    const c = chunk([{ generic: 'atorvastatin', brand: 'Lipitor', drugClass: 'statin' }]);
    assert.deepEqual([...termsFrom(c, 'drugs')].sort(), ['atorvastatin', 'lipitor', 'statin']);
  });

  test('empty when the field is missing or wrong-shaped', () => {
    assert.equal(termsFrom({ extras: {} }, 'drugs').size, 0);
    assert.equal(termsFrom({}, 'drugs').size, 0);
    assert.equal(termsFrom(chunk(null), 'drugs').size, 0);
    assert.equal(termsFrom(chunk([42, null, '']), 'drugs').size, 0);
  });
});

describe('matches', () => {
  test('exact, and either direction of substring', () => {
    // The real cases: the reader types the generic, the label carries the salt
    // form, the interaction table capitalizes. All three must match.
    const c = chunk([{ generic: 'atorvastatin calcium', brand: 'Lipitor' }]);
    assert.ok(matches(c, 'drugs', ['atorvastatin']), 'label has the salt form');
    assert.ok(matches(c, 'drugs', ['Atorvastatin Calcium']), 'case differs');
    assert.ok(matches(c, 'drugs', ['Lipitor']), 'brand name');
    assert.ok(!matches(c, 'drugs', ['metformin']));
  });

  test('no active list means no match', () => {
    assert.equal(matches(chunk(['aspirin']), 'drugs', []), false);
    assert.equal(matches(chunk(['aspirin']), 'drugs', undefined), false);
  });

  test('blank entries in the list are ignored', () => {
    assert.equal(matches(chunk(['aspirin']), 'drugs', ['', '   ']), false);
  });
});

describe('preferRank', () => {
  const active = ['metformin'];

  test('lifts a preferred passage above a slightly better unpreferred one', () => {
    const results = [
      chunk(['aspirin'], 0.62, 'unpreferred'),
      chunk(['metformin'], 0.55, 'preferred'),
    ];
    const out = preferRank(results, { key: 'drugs', active, boost: 0.12, limit: 2 });
    assert.equal(out[0].id, 'preferred');
    assert.equal(out[0].preferred, true);
    assert.equal(out[1].preferred, false);
  });

  test('does NOT let a weak match outrank a much stronger passage', () => {
    // The boost is a thumb on the scale, not a filter. A far more relevant
    // passage should still win.
    const results = [
      chunk(['aspirin'], 0.90, 'strong'),
      chunk(['metformin'], 0.40, 'weak-but-preferred'),
    ];
    const out = preferRank(results, { key: 'drugs', active, boost: 0.12, limit: 2 });
    assert.equal(out[0].id, 'strong');
  });

  test('never excludes — unpreferred passages stay reachable', () => {
    // This is the whole reason it is soft. "Can I add ibuprofen?" is about a
    // drug that is NOT on the list.
    const results = [
      chunk(['ibuprofen'], 0.70, 'not-taking'),
      chunk(['metformin'], 0.69, 'taking'),
    ];
    const out = preferRank(results, { key: 'drugs', active, boost: 0.12, limit: 5 });
    assert.equal(out.length, 2);
    assert.ok(out.some(r => r.id === 'not-taking'), 'unpreferred must survive');
  });

  test('with no active list it is a plain top-N', () => {
    const results = [chunk(['a'], 0.9, 'x'), chunk(['b'], 0.8, 'y'), chunk(['c'], 0.7, 'z')];
    const out = preferRank(results, { key: 'drugs', active: [], limit: 2 });
    assert.deepEqual(out.map(r => r.id), ['x', 'y']);
  });

  test('trims to the limit after re-ranking, not before', () => {
    const results = [
      chunk(['a'], 0.80, 'a'),
      chunk(['b'], 0.75, 'b'),
      chunk(['metformin'], 0.70, 'preferred'),
    ];
    const out = preferRank(results, { key: 'drugs', active, boost: 0.12, limit: 2 });
    assert.ok(out.some(r => r.id === 'preferred'),
      'the preferred passage was outside the limit before re-ranking and must survive it');
  });

  test('ties keep the order the store returned', () => {
    const results = [chunk(['a'], 0.5, 'first'), chunk(['b'], 0.5, 'second')];
    const out = preferRank(results, { key: 'drugs', active, limit: 2 });
    assert.deepEqual(out.map(r => r.id), ['first', 'second']);
  });
});

describe('availableTerms', () => {
  test('lists what the documents actually contain, most common first', () => {
    // Only real options: offering a drug with no documents behind it produces
    // an empty answer that looks like a bug.
    const chunks = [
      chunk([{ generic: 'metformin' }]),
      chunk([{ generic: 'metformin' }]),
      chunk([{ generic: 'aspirin' }]),
    ];
    const out = availableTerms(chunks, 'drugs');
    assert.deepEqual(out, [{ term: 'metformin', chunks: 2 }, { term: 'aspirin', chunks: 1 }]);
  });

  test('empty when nothing is tagged', () => {
    assert.deepEqual(availableTerms([{ extras: {} }], 'drugs'), []);
  });
});
