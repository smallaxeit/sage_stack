/**
 * rewrite.test.js — follow-up query rewriting.
 *
 *   node --test server/lib/rewrite.test.js
 *
 * No network: the model client is a double.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { looksLikeFollowUp, buildRewritePrompt, resolveSearchQuery } from './rewrite.js';

/** Client double that returns a fixed rewrite and records what it was asked. */
function fakeClient(reply = 'REWRITTEN QUERY') {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        if (reply instanceof Error) throw reply;
        return { content: [{ type: 'text', text: reply }] };
      },
    },
  };
}

const turn = (role, content) => ({ role, content });
const quiet = { log: () => {} };

describe('looksLikeFollowUp', () => {
  test('flags questions that cannot stand alone', () => {
    for (const q of [
      'What about the rear one?',
      'and the front?',
      'why?',
      'How about that',
      'Is it the same for 1986?',
      'What does that mean',
      'the other one',
      'So why did they change it?',
    ]) {
      assert.ok(looksLikeFollowUp(q), `should be a follow-up: "${q}"`);
    }
  });

  test('leaves self-contained questions alone', () => {
    for (const q of [
      'What is the front axle torque specification for a 1986 FXST?',
      'Explain the concept of divine sovereignty in the Hebrew Bible',
      'How much oil does the primary chaincase hold on a Softail',
      'Compare Plato and Aristotle on the nature of justice',
    ]) {
      assert.ok(!looksLikeFollowUp(q), `should be self-contained: "${q}"`);
    }
  });

  test('empty input is not a follow-up', () => {
    assert.equal(looksLikeFollowUp(''), false);
    assert.equal(looksLikeFollowUp(null), false);
  });
});

describe('resolveSearchQuery', () => {
  test('the first turn is never rewritten', async () => {
    const client = fakeClient();
    const r = await resolveSearchQuery({
      messages: [turn('user', 'What about it?')],   // follow-up shaped, but nothing precedes it
      client, log: quiet,
    });
    assert.equal(r.rewritten, false);
    assert.equal(r.query, 'What about it?');
    assert.equal(client.calls.length, 0, 'must not spend a call with no history');
  });

  test('a self-contained question costs nothing', async () => {
    const client = fakeClient();
    const r = await resolveSearchQuery({
      messages: [
        turn('user', 'What is the front axle torque for a 1986 FXST?'),
        turn('assistant', '45-50 ft-lb.'),
        turn('user', 'What is the rear brake caliper mounting bolt torque specification?'),
      ],
      client, log: quiet,
    });
    assert.equal(r.rewritten, false);
    assert.equal(r.reason, 'self-contained');
    assert.equal(client.calls.length, 0, 'no call for a question that already stands alone');
  });

  test('a follow-up is rewritten using the prior turns', async () => {
    const client = fakeClient('What is the rear axle torque for a 1986 FXST?');
    const r = await resolveSearchQuery({
      messages: [
        turn('user', 'What is the front axle torque for a 1986 FXST?'),
        turn('assistant', 'Front is 45-50 ft-lb.'),
        turn('user', 'What about the rear one?'),
      ],
      client, log: quiet,
    });
    assert.equal(r.rewritten, true);
    assert.equal(r.query, 'What is the rear axle torque for a 1986 FXST?');
    assert.equal(r.original, 'What about the rear one?');

    const prompt = client.calls[0].messages[0].content;
    assert.match(prompt, /front axle torque/, 'prior turns must reach the rewriter');
    assert.match(prompt, /What about the rear one\?/);
  });

  // The whole point: a rewrite is an optimization, never a dependency.
  test('falls back to the original question on every failure path', async () => {
    const question = 'What about the rear one?';
    const history = [
      turn('user', 'What is the front axle torque?'),
      turn('assistant', '45-50 ft-lb.'),
      turn('user', question),
    ];

    const cases = [
      ['no client',            { messages: history, client: null }],
      ['model throws',         { messages: history, client: fakeClient(new Error('502 upstream')) }],
      ['empty reply',          { messages: history, client: fakeClient('   ') }],
      ['rambling reply',       { messages: history, client: fakeClient('x'.repeat(900)) }],
    ];

    for (const [label, opts] of cases) {
      const r = await resolveSearchQuery({ ...opts, log: quiet });
      assert.equal(r.query, question, `${label}: must fall back to the original`);
      assert.equal(r.rewritten, false, `${label}: must not claim a rewrite`);
    }
  });

  test('can be disabled by passing no client', async () => {
    const r = await resolveSearchQuery({
      messages: [turn('user', 'a'), turn('assistant', 'b'), turn('user', 'what about it?')],
      client: null, log: quiet,
    });
    assert.equal(r.reason, 'no client');
    assert.equal(r.query, 'what about it?');
  });

  test('only the first line of a chatty reply is used', async () => {
    const client = fakeClient('The rear axle torque for a 1986 FXST?\n\nLet me know if you need more.');
    const r = await resolveSearchQuery({
      messages: [turn('user', 'front axle torque'), turn('assistant', '45'), turn('user', 'and the rear?')],
      client, log: quiet,
    });
    assert.equal(r.query, 'The rear axle torque for a 1986 FXST?');
  });
});

describe('buildRewritePrompt', () => {
  test('asks for the question only, and forbids adding information', () => {
    const p = buildRewritePrompt('User: a\nAssistant: b', 'what about it?');
    assert.match(p, /ONLY the rewritten question/i);
    assert.match(p, /Add no information/i);
    assert.match(p, /answer nothing/i);
  });
});
