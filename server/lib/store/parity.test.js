/**
 * parity.test.js — one suite, run against every store driver.
 *
 *   node --test server/lib/store/parity.test.js
 *
 * The files driver always runs. The postgres driver runs only when
 * TEST_DATABASE_URL is set and reachable — it is deliberately NOT taken from
 * DATABASE_URL, so a normal test run can never write into a working database
 * by accident.
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5433/db \
 *     node --test server/lib/store/parity.test.js
 *
 * Each run uses a throwaway subject slug and drops it afterwards.
 *
 * This suite is the whole point of Phase 1: "files or Postgres" is only a real
 * choice for as long as both drivers actually behave identically.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { createFilesStore } from './files.js';
import { createPostgresStore } from './postgres.js';

const DIM = 4;
const rnd = () => crypto.randomBytes(4).toString('hex');

// Vectors chosen so the expected ranking is obvious by inspection.
const V_A    = [1, 0, 0, 0];
const V_B    = [0, 1, 0, 0];
const V_NEAR = [0.9, 0.1, 0, 0]; // close to A, far from B
const QUERY  = [1, 0, 0, 0];

function sampleChunks() {
  return [
    { id: 'c1', source: 'alpha.txt', chunkIndex: 0, text: 'first chunk about alpha',
      summary: 's1', difficulty: 'beginner', concepts: ['alpha'], themes: ['t1'],
      extras: { spec: 'x' }, embedding: V_A },
    { id: 'c2', source: 'beta.txt', chunkIndex: 0, text: 'second chunk about beta',
      concepts: ['beta'], embedding: V_B },
    { id: 'c3', source: 'alpha.txt', chunkIndex: 1, text: 'third chunk, near alpha',
      embedding: V_NEAR },
    // No embedding — exercises the missing/backfill path.
    { id: 'c4', source: 'gamma.txt', chunkIndex: 0, text: 'fourth chunk, unembedded' },
  ];
}

/** Every assertion in the contract, parameterised by driver. */
function runParitySuite(driverName, makeStore, { skip = false } = {}) {
  describe(`store parity: ${driverName}`, { skip }, () => {
    let store;
    let slug;

    before(async () => {
      store = await makeStore();
      slug = `paritytest_${rnd()}`;
    });

    after(async () => {
      try { if (store && slug) await store.dropSubject(slug); } catch { /* best effort */ }
      try { if (store) await store.close(); } catch { /* best effort */ }
    });

    test('initSubject creates a subject with the given dim', async () => {
      const meta = await store.initSubject(slug, { dim: DIM, embedModel: 'test-model', name: 'Parity Test' });
      assert.equal(meta.slug, slug);
      assert.equal(meta.dim, DIM);
      assert.equal(meta.embedModel, 'test-model');
      assert.equal(meta.name, 'Parity Test');
      assert.equal(meta.chunkCount, 0);
    });

    test('initSubject is idempotent at the same dim', async () => {
      const meta = await store.initSubject(slug, { dim: DIM });
      assert.equal(meta.dim, DIM);
    });

    test('initSubject refuses a dim change', async () => {
      await assert.rejects(
        () => store.initSubject(slug, { dim: DIM + 1 }),
        /refusing to reinit|already exists/i,
      );
    });

    test('listSubjects includes the subject', async () => {
      const subjects = await store.listSubjects();
      assert.ok(subjects.some(s => s.slug === slug), 'subject missing from listSubjects');
    });

    test('getSubjectMeta returns it; unknown slug returns null', async () => {
      const meta = await store.getSubjectMeta(slug);
      assert.equal(meta.dim, DIM);
      assert.equal(await store.getSubjectMeta(`paritytest_absent_${rnd()}`), null);
    });

    test('upsertChunks inserts and counts correctly', async () => {
      const n = await store.upsertChunks(slug, sampleChunks());
      assert.equal(n, 4);
      assert.deepEqual(await store.countChunks(slug), { total: 4, withEmbedding: 3 });
    });

    test('getChunks returns the canonical shape in insertion order', async () => {
      const chunks = await store.getChunks(slug);
      assert.equal(chunks.length, 4);
      assert.deepEqual(chunks.map(c => c.id), ['c1', 'c2', 'c3', 'c4']);

      const c1 = chunks[0];
      assert.equal(c1.source, 'alpha.txt');
      assert.equal(c1.chunkIndex, 0);
      assert.equal(c1.text, 'first chunk about alpha');
      assert.equal(c1.summary, 's1');
      assert.equal(c1.difficulty, 'beginner');
      assert.deepEqual(c1.concepts, ['alpha']);
      assert.deepEqual(c1.themes, ['t1']);
      assert.deepEqual(c1.extras, { spec: 'x' });
      assert.equal(c1.pdfPage, null);
      assert.equal(c1.printedPage, null);
      assert.ok(!('embedding' in c1), 'embedding must be omitted unless requested');
      assert.ok(!('hasEmbedding' in c1), 'hasEmbedding is driver-internal, must not leak');

      // Defaults applied to the sparse chunk.
      assert.equal(chunks[1].summary, '');
      assert.deepEqual(chunks[1].themes, []);
      assert.deepEqual(chunks[1].extras, {});
    });

    test('getChunks honours limit and offset', async () => {
      const page = await store.getChunks(slug, { limit: 2, offset: 1 });
      assert.deepEqual(page.map(c => c.id), ['c2', 'c3']);
    });

    test('getChunks can return embeddings', async () => {
      const [c1] = await store.getChunks(slug, { limit: 1, withEmbeddings: true });
      assert.equal(c1.embedding.length, DIM);
      // float32 storage on both sides, so compare with tolerance
      c1.embedding.forEach((v, i) => assert.ok(Math.abs(v - V_A[i]) < 1e-6));
      const [, , , c4] = await store.getChunks(slug, { withEmbeddings: true });
      assert.equal(c4.embedding, null);
    });

    test('upsert on an existing id updates without duplicating', async () => {
      await store.upsertChunks(slug, [{ id: 'c1', source: 'alpha.txt', chunkIndex: 0, text: 'REVISED' }]);
      const chunks = await store.getChunks(slug);
      assert.equal(chunks.length, 4, 'upsert must not create a duplicate row');
      assert.equal(chunks[0].text, 'REVISED');
      assert.deepEqual(chunks.map(c => c.id), ['c1', 'c2', 'c3', 'c4'], 'order must be stable across upsert');
    });

    test('upsert without an embedding preserves the existing one', async () => {
      // c1 was just re-upserted with no embedding — it must still be embedded.
      assert.deepEqual(await store.countChunks(slug), { total: 4, withEmbedding: 3 });
    });

    test('chunksMissingEmbeddings finds the unembedded chunk', async () => {
      const missing = await store.chunksMissingEmbeddings(slug);
      assert.deepEqual(missing.map(m => m.id), ['c4']);
      assert.equal(missing[0].text, 'fourth chunk, unembedded');
      assert.equal((await store.chunksMissingEmbeddings(slug, { limit: 1 })).length, 1);
    });

    test('setEmbeddings backfills', async () => {
      const n = await store.setEmbeddings(slug, [{ id: 'c4', vector: [0, 0, 1, 0] }]);
      assert.equal(n, 1);
      assert.deepEqual(await store.countChunks(slug), { total: 4, withEmbedding: 4 });
      assert.deepEqual(await store.chunksMissingEmbeddings(slug), []);
    });

    test('setEmbeddings ignores unknown ids', async () => {
      assert.equal(await store.setEmbeddings(slug, [{ id: 'nope', vector: [1, 0, 0, 0] }]), 0);
    });

    test('setEmbeddings rejects a wrong dimension', async () => {
      await assert.rejects(
        () => store.setEmbeddings(slug, [{ id: 'c1', vector: [1, 0] }]),
        /dims/i,
      );
    });

    test('searchByVector ranks by cosine similarity', async () => {
      const results = await store.searchByVector(slug, QUERY, 3);
      assert.equal(results.length, 3);
      assert.deepEqual(results.slice(0, 2).map(r => r.id), ['c1', 'c3'],
        'exact match first, then the near vector');

      assert.ok(Math.abs(results[0].score - 1) < 1e-5, `expected score ~1, got ${results[0].score}`);
      const expectedNear = 0.9 / Math.sqrt(0.9 * 0.9 + 0.1 * 0.1);
      assert.ok(Math.abs(results[1].score - expectedNear) < 1e-5,
        `expected ~${expectedNear}, got ${results[1].score}`);

      // Scores must be ordered and results must carry chunk metadata.
      for (let i = 1; i < results.length; i++) {
        assert.ok(results[i - 1].score >= results[i].score, 'results must be sorted by score desc');
      }
      assert.equal(results[0].source, 'alpha.txt');
      assert.ok(!('embedding' in results[0]), 'search results must not carry embeddings');
    });

    test('searchByVector honours topK', async () => {
      assert.equal((await store.searchByVector(slug, QUERY, 1)).length, 1);
    });

    test('searchByVector rejects a wrong-dimension query', async () => {
      await assert.rejects(() => store.searchByVector(slug, [1, 0], 3), /dims/i);
    });

    test('concept map round-trips', async () => {
      assert.equal(await store.getConceptMap(slug), null);
      const map = { coreThemes: ['a', 'b'], concepts: [{ name: 'x', description: 'y' }] };
      await store.saveConceptMap(slug, map);
      assert.deepEqual(await store.getConceptMap(slug), map);
    });

    test('sessions round-trip', async () => {
      const id = `sess-${rnd()}`;
      assert.equal(await store.getSession(id), null);
      const messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
      await store.saveSession(id, messages);
      assert.deepEqual(await store.getSession(id), messages);
      await store.saveSession(id, [...messages, { role: 'user', content: 'again' }]);
      assert.equal((await store.getSession(id)).length, 3);
      assert.equal(await store.deleteSession(id), true);
      assert.equal(await store.getSession(id), null);
      assert.equal(await store.deleteSession(id), false);
    });

    test('rejects an invalid slug', async () => {
      for (const bad of ['Bad-Slug', '1leading', '../escape', '', 'a'.repeat(64)]) {
        await assert.rejects(() => store.initSubject(bad, { dim: DIM }), /Invalid subject slug/);
      }
    });

    test('dropSubject removes everything', async () => {
      assert.equal(await store.dropSubject(slug), true);
      assert.equal(await store.getSubjectMeta(slug), null);
      assert.ok(!(await store.listSubjects()).some(s => s.slug === slug));
      assert.equal(await store.dropSubject(slug), false, 'dropping twice must report false');
    });
  });
}

/**
 * Subject isolation — the multi-client guardrail.
 *
 * Subjects are tenants: no crossover, ever. The architecture makes this
 * structural rather than disciplinary. A shared table with a `subject` column
 * would mean one forgotten WHERE clause leaks every customer's data; with a
 * directory per subject (files) and a SCHEMA per subject (postgres) there is no
 * query that can return two subjects' rows without explicitly naming both.
 *
 * These tests exist to keep it that way.
 */
function runIsolationSuite(driverName, makeStore, { skip = false } = {}) {
  describe(`subject isolation: ${driverName}`, { skip }, () => {
    let store, A, B;

    before(async () => {
      store = await makeStore();
      A = `paritytest_a_${rnd()}`;
      B = `paritytest_b_${rnd()}`;
      await store.initSubject(A, { dim: DIM, name: 'Client A' });
      await store.initSubject(B, { dim: DIM, name: 'Client B' });

      // Deliberately identical ids and identical vectors in both subjects.
      await store.upsertChunks(A, [
        { id: 'shared-id', source: 'a-secret.txt', chunkIndex: 0, text: 'CLIENT A CONFIDENTIAL', embedding: V_A },
        { id: 'a-only', source: 'a-secret.txt', chunkIndex: 1, text: 'also client A', embedding: V_NEAR },
      ]);
      await store.upsertChunks(B, [
        { id: 'shared-id', source: 'b-secret.txt', chunkIndex: 0, text: 'CLIENT B CONFIDENTIAL', embedding: V_A },
      ]);
    });

    after(async () => {
      for (const s of [A, B]) { try { await store.dropSubject(s); } catch {} }
      try { await store.close(); } catch {}
    });

    test('the same chunk id in two subjects holds different content', async () => {
      const [a] = await store.getChunks(A, { limit: 1 });
      const [b] = await store.getChunks(B, { limit: 1 });
      assert.equal(a.id, b.id, 'precondition: ids collide across subjects');
      assert.equal(a.text, 'CLIENT A CONFIDENTIAL');
      assert.equal(b.text, 'CLIENT B CONFIDENTIAL');
    });

    test('counts are scoped to the subject', async () => {
      assert.equal((await store.countChunks(A)).total, 2);
      assert.equal((await store.countChunks(B)).total, 1);
    });

    test('getChunks never returns another subject rows', async () => {
      for (const c of await store.getChunks(A)) assert.ok(!c.source.startsWith('b-'), `leaked: ${c.source}`);
      for (const c of await store.getChunks(B)) assert.ok(!c.source.startsWith('a-'), `leaked: ${c.source}`);
    });

    test('search cannot cross subjects, even on an identical vector', async () => {
      // Both subjects contain V_A verbatim. A search in B must return B's copy
      // and nothing of A's, and must not see A's extra chunk at all.
      const inB = await store.searchByVector(B, QUERY, 10);
      assert.equal(inB.length, 1, 'B has exactly one chunk; search must not reach into A');
      assert.equal(inB[0].text, 'CLIENT B CONFIDENTIAL');

      const inA = await store.searchByVector(A, QUERY, 10);
      assert.equal(inA.length, 2);
      for (const r of inA) assert.ok(!r.text.includes('CLIENT B'), 'A leaked B content');
    });

    test('concept maps are scoped', async () => {
      await store.saveConceptMap(A, { coreThemes: ['a-theme'] });
      assert.deepEqual(await store.getConceptMap(A), { coreThemes: ['a-theme'] });
      assert.equal(await store.getConceptMap(B), null, 'B must not see A concept map');
    });

    test('subjects may use different embedding dimensions', async () => {
      // The reason for schema-per-subject: pgvector fixes dimension per column,
      // so a shared table could not hold a 1024-dim and a 768-dim subject.
      const C = `paritytest_c_${rnd()}`;
      try {
        await store.initSubject(C, { dim: 8 });
        await store.upsertChunks(C, [
          { id: 'x', source: 'c.txt', chunkIndex: 0, text: 'eight dims', embedding: [1, 0, 0, 0, 0, 0, 0, 0] },
        ]);
        const hits = await store.searchByVector(C, [1, 0, 0, 0, 0, 0, 0, 0], 5);
        assert.equal(hits.length, 1);
        assert.equal((await store.getSubjectMeta(C)).dim, 8);
        // The 4-dim subject is unaffected and still rejects an 8-dim query.
        assert.equal((await store.getSubjectMeta(A)).dim, DIM);
        await assert.rejects(() => store.searchByVector(A, [1, 0, 0, 0, 0, 0, 0, 0], 5), /dims/i);
      } finally {
        await store.dropSubject(C);
      }
    });

    test('dropping one subject leaves the other intact', async () => {
      assert.equal(await store.dropSubject(A), true);
      assert.equal(await store.getSubjectMeta(A), null);
      assert.equal((await store.countChunks(B)).total, 1, 'B destroyed by dropping A');
      assert.equal((await store.searchByVector(B, QUERY, 10))[0].text, 'CLIENT B CONFIDENTIAL');
    });
  });
}

// ─── files driver ─────────────────────────────────────────────────────────────

let tmpRoot;
const makeFilesStore = async () => {
  tmpRoot = tmpRoot || await fs.mkdtemp(path.join(os.tmpdir(), 'sagestack-parity-'));
  return createFilesStore({ root: path.join(tmpRoot, 'subjects') });
};
runParitySuite('files', makeFilesStore);
runIsolationSuite('files', makeFilesStore);

process.on('exit', () => {
  if (tmpRoot) { try { require('fs').rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }
});

// ─── postgres driver (opt-in) ─────────────────────────────────────────────────

const PG_URL = process.env.TEST_DATABASE_URL;
let pgSkip = 'TEST_DATABASE_URL not set';

if (PG_URL) {
  try {
    const probe = createPostgresStore({ connectionString: PG_URL, max: 1 });
    await probe.listSubjects(); // forces connect + pgvector check
    await probe.close();
    pgSkip = false;
  } catch (err) {
    pgSkip = `postgres unreachable: ${err.message.split('\n')[0]}`;
  }
}

const makePgStore = async () => createPostgresStore({ connectionString: PG_URL, max: 2 });
runParitySuite('postgres', makePgStore, { skip: pgSkip });
runIsolationSuite('postgres', makePgStore, { skip: pgSkip });
