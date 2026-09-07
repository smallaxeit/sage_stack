/**
 * prefer.test.js — soft filtering of retrieval results.
 *
 *   node --test server/lib/prefer.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { termsFrom, matches, preferRank, coverActive, availableTerms } from './prefer.js';

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

describe('coverActive', () => {
  const active = ['rosuvastatin', 'losartan', 'amlodipine', 'spironolactone'];

  test('gives a listed item its passage when ranking gave it none', () => {
    // The real failure: two rosuvastatin inserts were half the documents, took
    // every ranked slot, and the answer reported amlodipine as not covered —
    // while 24 embedded, tagged amlodipine passages sat in the store.
    const pool = [
      chunk(['rosuvastatin'], 0.71, 'r1'),
      chunk(['rosuvastatin'], 0.70, 'r2'),
      chunk(['losartan'], 0.64, 'l1'),
      chunk(['spironolactone'], 0.61, 's1'),
      chunk(['amlodipine'], 0.44, 'a1'),
      chunk(['amlodipine'], 0.41, 'a2'),
    ];
    const ranked = pool.slice(0, 4);

    const { results, uncovered } = coverActive(ranked, pool, { key: 'drugs', active });

    assert.deepEqual(uncovered, [], 'the pool had amlodipine, so nothing is uncovered');
    assert.ok(results.some(r => r.id === 'a1'), 'its best passage is pulled in');
    assert.equal(results.find(r => r.id === 'a1').coveredFor, 'amlodipine');
    // Ranking is not disturbed; coverage is appended.
    assert.deepEqual(results.slice(0, 4).map(r => r.id), ['r1', 'r2', 'l1', 's1']);
  });

  test('takes the best-scoring passage for the item, not just any', () => {
    const pool = [
      chunk(['rosuvastatin'], 0.71, 'r1'),
      chunk(['amlodipine'], 0.44, 'best'),
      chunk(['amlodipine'], 0.20, 'worse'),
    ];
    const { results } = coverActive([pool[0]], pool, {
      key: 'drugs', active: ['rosuvastatin', 'amlodipine'],
    });
    assert.ok(results.some(r => r.id === 'best'));
    assert.ok(!results.some(r => r.id === 'worse'));
  });

  test('reports what the pool cannot cover rather than inventing it', () => {
    // A question worded for one drug embeds nowhere near another's pages, so
    // the pool can legitimately hold nothing for it. Saying so lets the caller
    // search again; silence here is what produced a false "not covered".
    const pool = [chunk(['rosuvastatin'], 0.71, 'r1')];
    const { results, uncovered } = coverActive(pool, pool, { key: 'drugs', active });
    assert.deepEqual(uncovered, ['losartan', 'amlodipine', 'spironolactone']);
    assert.equal(results.length, 1);
  });

  test('coverPerTerm controls the floor', () => {
    const pool = [
      chunk(['rosuvastatin'], 0.71, 'r1'),
      chunk(['amlodipine'], 0.44, 'a1'),
      chunk(['amlodipine'], 0.41, 'a2'),
      chunk(['amlodipine'], 0.39, 'a3'),
    ];
    const { results } = coverActive([pool[0]], pool, {
      key: 'drugs', active: ['amlodipine'], limit: 2,
    });
    assert.deepEqual(results.filter(r => r.coveredFor).map(r => r.id), ['a1', 'a2']);
  });

  test('adds nothing when ranking already covered everything', () => {
    const pool = [chunk(['rosuvastatin'], 0.71, 'r1'), chunk(['amlodipine'], 0.44, 'a1')];
    const { results, uncovered } = coverActive(pool, pool, {
      key: 'drugs', active: ['rosuvastatin', 'amlodipine'],
    });
    assert.equal(results.length, 2);
    assert.deepEqual(uncovered, []);
  });

  test('never duplicates a passage already selected', () => {
    // One passage can name several of the listed drugs — an interaction table
    // routinely does — and must not be added once per drug.
    const both = chunk([{ generic: 'amlodipine' }, { generic: 'losartan' }], 0.5, 'both');
    const pool = [chunk(['rosuvastatin'], 0.71, 'r1'), both];
    const { results } = coverActive([pool[0]], pool, {
      key: 'drugs', active: ['amlodipine', 'losartan'],
    });
    assert.equal(results.filter(r => r.id === 'both').length, 1);
  });

  test('a subject with no preference list is untouched', () => {
    const ranked = [chunk(['aspirin'], 0.5, 'a')];
    assert.deepEqual(coverActive(ranked, ranked, { key: 'drugs', active: [] }).results, ranked);
    assert.deepEqual(coverActive(ranked, ranked, {}).results, ranked);
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
