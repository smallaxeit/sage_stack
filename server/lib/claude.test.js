/**
 * claude.test.js — context assembly and the teacher, against fakes.
 *
 *   node --test server/lib/claude.test.js
 *
 * No API key and no network: the Anthropic client, the store, the embedder and
 * retrieval are all injected.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildContext, createTeacher } from './claude.js';
import { normalizeProfile, loadSubject } from './subjects.js';

const profile = normalizeProfile('demo', {
  voice: 'VOICE',
  sourceAliases: { 'plato-republic.txt': 'The Republic — Plato' },
  retrieval: { topK: 3 },
  chat: { model: 'claude-sonnet-5', maxTokens: 1234 },
});

const chunk = (over = {}) => ({
  id: 'c1', source: 'plato-republic.txt', chunkIndex: 0,
  text: 'Justice is the excellence of the soul.',
  concepts: ['justice'], themes: ['ethics'], extras: {}, pdfPage: null, printedPage: null,
  ...over,
});

/** Minimal Anthropic client double. */
function fakeClient(text = 'ANSWER') {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        return { content: [{ type: 'text', text }], usage: { output_tokens: 7 } };
      },
      stream: async (req) => {
        calls.push(req);
        return {
          async *[Symbol.asyncIterator]() {
            for (const t of text.split(' ')) {
              yield { type: 'content_block_delta', delta: { type: 'text_delta', text: t + ' ' } };
            }
          },
          finalMessage: async () => ({ usage: { output_tokens: 9 } }),
        };
      },
    },
  };
}

const quiet = { log: () => {} };

/** The system prompt is sent as cacheable blocks; flatten for assertions. */
const systemText = (req) =>
  Array.isArray(req.system) ? req.system.map(b => b.text).join("") : String(req.system);

describe('buildContext', () => {
  test('renders passages with friendly source names', () => {
    const { contextStr } = buildContext(profile, [chunk()]);
    assert.ok(contextStr.includes('The Republic — Plato'));
    assert.ok(!contextStr.includes('plato-republic.txt'), 'raw filename leaked');
    assert.ok(contextStr.includes('Justice is the excellence of the soul.'));
    assert.ok(contextStr.includes('Concepts: justice'));
  });

  test('an unaliased filename is tidied, not dropped', () => {
    const { sources } = buildContext(profile, [chunk({ source: 'mill-on-liberty.txt' })]);
    assert.equal(sources[0].source, 'mill on liberty');
  });

  test('subject-specific extras become metadata, generically', () => {
    // Theology contributes scriptureRefs; a manual contributes componentTags.
    // buildContext knows about neither by name.
    const { contextStr } = buildContext(profile, [
      chunk({ extras: { scriptureRefs: ['Genesis 1:1'], componentTags: ['front brake'] } }),
    ]);
    assert.ok(contextStr.includes('scriptureRefs: Genesis 1:1'));
    assert.ok(contextStr.includes('componentTags: front brake'));
  });

  test('non-string-array extras are skipped rather than rendered as [object Object]', () => {
    const { contextStr } = buildContext(profile, [
      chunk({ extras: { specs: [{ name: 'torque', value: 25 }], count: 3 } }),
    ]);
    assert.ok(!contextStr.includes('[object Object]'));
    assert.ok(!contextStr.includes('specs:'));
  });

  test('page numbers appear when ingestion produced them', () => {
    const { contextStr, sources } = buildContext(profile, [
      chunk({ pdfPage: 539, printedPage: '541' }),
    ]);
    // pdfPage is 0-based internally, shown 1-based.
    assert.ok(contextStr.includes('p.540 (printed 541)'), contextStr);
    assert.equal(sources[0].page, 540);
    assert.equal(sources[0].printedPage, '541');
  });

  test('sources are deduplicated', () => {
    const { sources } = buildContext(profile, [chunk(), chunk({ id: 'c2', chunkIndex: 1 })]);
    assert.equal(sources.length, 1);
  });

  test('chips draw from concepts and extras, capped at 6, no duplicates', () => {
    const { chips } = buildContext(profile, [
      chunk({ concepts: ['justice', 'virtue'], extras: { scriptureRefs: ['Gen 1:1', 'justice'] } }),
      chunk({ id: 'c2', concepts: ['a', 'b', 'c', 'd', 'e'] }),
    ]);
    assert.ok(chips.length <= 6);
    assert.equal(new Set(chips).size, chips.length, 'chips must be unique');
    assert.ok(chips.includes('justice'));
  });

  test('an absurdly long chunk is truncated rather than flooding the prompt', () => {
    // A real one: the theology import carried a 1.24 MB chunk — the whole of
    // Plato's Republic as a single row from an older pipeline. Retrieved, it put
    // ~310,000 tokens into one request (~$0.62) and drowned the nine genuine
    // passages beside it.
    const huge = 'x'.repeat(500_000);
    const { contextStr } = buildContext(profile, [chunk({ text: huge })]);

    assert.ok(contextStr.length < 20_000,
      `context should be bounded, got ${contextStr.length} chars`);
    assert.match(contextStr, /passage truncated/);
    assert.match(contextStr, /500,000 characters/);
  });

  test('a normal chunk is passed through untouched', () => {
    const normal = 'y'.repeat(2000);
    const { contextStr } = buildContext(profile, [chunk({ text: normal })]);
    assert.ok(contextStr.includes(normal), 'a sane chunk must not be altered');
    assert.ok(!contextStr.includes('truncated'));
  });

  test('no results produces an explicit instruction, not silence', () => {
    const { contextStr, sources, chips } = buildContext(profile, []);
    assert.ok(/No closely matching passages/.test(contextStr));
    assert.ok(/rather than answering from outside the sources/.test(contextStr));
    assert.deepEqual(sources, []);
    assert.deepEqual(chips, []);
  });
});

describe('createTeacher', () => {
  test('requires a profile', () => {
    assert.throws(() => createTeacher({}), /requires a subject profile/);
  });

  test('chat sends the profile model, max_tokens and assembled prompt', async () => {
    const client = fakeClient('Justice, then.');
    const teacher = createTeacher({
      profile, client, log: quiet,
      retrieve: async () => [chunk()],
    });

    const out = await teacher.chat([{ role: 'user', content: 'what is justice' }], { mode: 'deep' });
    assert.equal(out.text, 'Justice, then.');
    assert.equal(out.outputTokens, 7);
    assert.equal(out.sources.length, 1);

    const req = client.calls[0];
    assert.equal(req.model, 'claude-sonnet-5');
    assert.equal(req.max_tokens, 1234);
    assert.ok(systemText(req).includes('VOICE'), 'profile voice missing from system prompt');
    assert.ok(systemText(req).includes('The Republic — Plato'), 'context missing from system prompt');
  });

  test('the system prompt is split for caching, with the varying half second', async () => {
    // Caching is a PREFIX match: the first block must be byte-identical across
    // questions, and anything per-request must live in the second. Getting this
    // backwards silently costs money forever — the cache would never hit.
    const client = fakeClient();
    const teacher = createTeacher({ profile, client, log: quiet, retrieve: async () => [chunk()] });
    await teacher.chat([{ role: 'user', content: 'q' }]);

    const { system } = client.calls[0];
    assert.ok(Array.isArray(system), 'system must be blocks, not a string');
    assert.equal(system.length, 2);

    const [stable, varying] = system;
    assert.deepEqual(stable.cache_control, { type: 'ephemeral' }, 'the stable half must be marked cacheable');
    assert.equal(varying.cache_control, undefined, 'the varying half must NOT be cached');

    assert.ok(stable.text.includes('VOICE'), 'voice belongs in the cached prefix');
    assert.ok(!stable.text.includes('The Republic'), 'retrieved passages must not be in the cached prefix');
    assert.ok(varying.text.includes('The Republic'), 'passages belong in the varying block');
  });

  test('the cached prefix is identical across different questions', async () => {
    // The actual guarantee. If any per-request value leaked into the prefix,
    // these would differ and the cache would never hit.
    const client = fakeClient();
    let n = 0;
    const teacher = createTeacher({
      profile, client, log: quiet,
      retrieve: async () => [chunk({ id: `c${n}`, text: `passage number ${n++}` })],
    });

    await teacher.chat([{ role: 'user', content: 'first question' }]);
    await teacher.chat([{ role: 'user', content: 'an entirely different question' }]);

    assert.equal(client.calls[0].system[0].text, client.calls[1].system[0].text,
      'the cached prefix drifted between requests');
    assert.notEqual(client.calls[0].system[1].text, client.calls[1].system[1].text,
      'precondition: the varying block should actually vary');
  });

  test('chatStream streams deltas and returns the full text', async () => {
    const client = fakeClient('one two three');
    const teacher = createTeacher({ profile, client, log: quiet, retrieve: async () => [chunk()] });

    const seen = [];
    const out = await teacher.chatStream(
      [{ role: 'user', content: 'q' }], t => seen.push(t), { mode: 'quick' });

    assert.equal(seen.join('').trim(), 'one two three');
    assert.equal(out.text.trim(), 'one two three');
    assert.equal(out.outputTokens, 9);
  });

  test('retrieval is scoped to the subject and honors topK', async () => {
    const seen = [];
    const store = {
      getSubjectMeta: async () => ({ embedModel: 'voyage-3.5', dim: 4 }),
      searchByVector: async (slug, vec, topK) => { seen.push({ slug, topK }); return [chunk()]; },
      getConceptMap: async () => null,
    };
    const embedder = { driver: 'voyage', model: 'voyage-3.5', dim: 4, embedQuery: async () => [1, 0, 0, 0] };
    const teacher = createTeacher({ profile, store, embedder, client: fakeClient(), log: quiet });

    await teacher.chat([{ role: 'user', content: 'q' }]);
    assert.deepEqual(seen, [{ slug: 'demo', topK: 3 }]);
  });

  test('refuses to answer when the embedder does not match the subject', async () => {
    const store = {
      // Subject was built with voyage-3; the active embedder is voyage-3.5.
      // Both are 1024-dim, so only the model check catches this.
      getSubjectMeta: async () => ({ embedModel: 'voyage-3', dim: 1024 }),
      searchByVector: async () => { throw new Error('must not be reached'); },
      getConceptMap: async () => null,
    };
    const embedder = { driver: 'voyage', model: 'voyage-3.5', dim: 1024, embedQuery: async () => [] };
    const teacher = createTeacher({ profile, store, embedder, client: fakeClient(), log: quiet });

    await assert.rejects(() => teacher.chat([{ role: 'user', content: 'q' }]), /model mismatch/);
  });

  test('an unbuilt subject fails with a clear message', async () => {
    const store = { getSubjectMeta: async () => null, getConceptMap: async () => null };
    const embedder = { driver: 'voyage', model: 'voyage-3.5', dim: 1024, embedQuery: async () => [] };
    const teacher = createTeacher({ profile, store, embedder, client: fakeClient(), log: quiet });
    await assert.rejects(() => teacher.chat([{ role: 'user', content: 'q' }]),
      /has no built knowledge base yet/);
  });

  test('the concept map is fetched only when the subject enables it', async () => {
    let fetched = 0;
    const store = {
      getSubjectMeta: async () => ({ embedModel: 'voyage-3.5', dim: 4 }),
      searchByVector: async () => [chunk()],
      getConceptMap: async () => { fetched++; return { coreThemes: ['grace'] }; },
    };
    const embedder = { driver: 'voyage', model: 'voyage-3.5', dim: 4, embedQuery: async () => [1, 0, 0, 0] };

    const off = createTeacher({ profile, store, embedder, client: fakeClient(), log: quiet });
    await off.chat([{ role: 'user', content: 'q' }]);
    assert.equal(fetched, 0, 'disabled subject must not fetch a concept map');

    const onProfile = normalizeProfile('demo', { voice: 'V', conceptMap: { enabled: true } });
    const client = fakeClient();
    const on = createTeacher({ profile: onProfile, store, embedder, client, log: quiet });
    await on.chat([{ role: 'user', content: 'q' }]);
    assert.equal(fetched, 1);
    assert.ok(systemText(client.calls[0]).includes('grace'));
  });

  test('needs either retrieve, or store plus embedder', async () => {
    const teacher = createTeacher({ profile, client: fakeClient(), log: quiet });
    await assert.rejects(() => teacher.chat([{ role: 'user', content: 'q' }]),
      /requires either `retrieve`, or both `store` and `embedder`/);
  });
});

describe('the theology subject end to end', () => {
  test('a real profile produces a prompt with voice, aliases and mode', async () => {
    const theology = await loadSubject('theology');
    const client = fakeClient();
    const teacher = createTeacher({
      profile: theology, client, log: quiet,
      retrieve: async () => [chunk({ source: 'plato-republic.txt' })],
    });

    await teacher.chat([{ role: 'user', content: 'what is justice' }], { mode: 'deep' });
    const sys = systemText(client.calls[0]);
    assert.ok(sys.includes('John Keating'), 'theology voice missing');
    assert.ok(sys.includes('RESPONSE MODE: Deep'));
    assert.ok(sys.includes('The Republic — Plato'), 'sourceAliases not applied');
    assert.equal(client.calls[0].model, 'claude-sonnet-5');
  });
});
