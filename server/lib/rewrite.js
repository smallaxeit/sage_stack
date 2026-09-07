/**
 * rewrite.js — turn a follow-up into a standalone search query.
 *
 * The problem this solves is easy to miss because the answer still looks
 * plausible. Retrieval embeds only the current question, while the model sees
 * the whole conversation. So:
 *
 *   "What is the front axle torque?"     -> retrieves the torque tables
 *   "What about the rear one?"           -> embeds six words with no subject
 *
 * The second query has almost no signal. It retrieves whatever is vaguely near
 * "rear", the model gets passages that do not answer the question, and — being
 * strictly grounded — it says the passages do not cover it. The conversation
 * looks like the knowledge base has a gap when the gap is in the query.
 *
 * A rewrite costs one small-model call. Haiku at ~250 tokens in and ~30 out is
 * well under a tenth of a cent, against a chat turn costing cents — and a
 * failed retrieval wastes the whole turn anyway.
 */

import { purposeConfig } from './models.js';

const { model: REWRITE_MODEL, maxTokens: REWRITE_MAX_TOKENS } = purposeConfig('rewrite');

/** How many prior turns to show. Enough for a pronoun, not enough to drift. */
const CONTEXT_TURNS = 4;

/**
 * Does this look like it cannot stand alone?
 *
 * Checked first because most questions are self-contained, and paying for a
 * rewrite on those is pure waste. Deliberately generous: a needless rewrite
 * costs a fraction of a cent, a missed one wastes an entire turn.
 */
export function looksLikeFollowUp(text) {
  const t = String(text || '').trim();
  if (!t) return false;

  // Short questions rarely carry enough on their own.
  const words = t.split(/\s+/).length;
  if (words <= 4) return true;

  return (
    // Opens with a connective: "what about…", "and the…", "so why…"
    /^(what about|how about|and |but |so |then |what if|why not)\b/i.test(t) ||
    // Refers to something only the prior turn named.
    /\b(it|its|it's|that|this|those|these|them|they|there|the same|the other|the first|the second|the latter|the former)\b/i.test(t) ||
    // A bare comparative with no subject: "the rear one", "a bigger one"
    /\b(one|ones)\b\s*[?.]?$/i.test(t)
  );
}

/** The recent turns, trimmed so a long answer cannot dominate the prompt. */
function recentTurns(messages) {
  return messages
    .slice(-1 - CONTEXT_TURNS, -1)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 400)}`)
    .join('\n');
}

export function buildRewritePrompt(history, question) {
  return `Rewrite the user's latest question so it can be understood on its own, without the conversation.

Conversation so far:
${history}

Latest question: ${question}

Rules:
- Replace pronouns and references with what they actually refer to.
- Keep the user's own wording wherever it already stands alone.
- Add no information that is not in the conversation, and answer nothing.
- If the question already stands alone, return it unchanged.

Return ONLY the rewritten question, on one line, with no preamble.`;
}

/**
 * Resolve the text to embed for retrieval.
 *
 * Returns the original question unchanged whenever a rewrite is unnecessary,
 * impossible, or fails — retrieval degrades to today's behavior rather than
 * breaking. A rewrite is an optimization, never a dependency.
 */
export async function resolveSearchQuery({ messages, client, model = REWRITE_MODEL, log } = {}) {
  const question = String([...messages].reverse().find(m => m.role === 'user')?.content ?? '').trim();
  const priorTurns = messages.filter(m => m.role === 'user' || m.role === 'assistant').length - 1;

  if (!question) return { query: '', rewritten: false, reason: 'empty' };
  if (priorTurns < 1) return { query: question, rewritten: false, reason: 'first turn' };
  if (!client) return { query: question, rewritten: false, reason: 'no client' };
  if (!looksLikeFollowUp(question)) return { query: question, rewritten: false, reason: 'self-contained' };

  const history = recentTurns(messages);
  if (!history) return { query: question, rewritten: false, reason: 'no usable history' };

  try {
    const res = await client.messages.create({
      model,
      max_tokens: REWRITE_MAX_TOKENS,
      messages: [{ role: 'user', content: buildRewritePrompt(history, question) }],
    });
    const out = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim().split('\n')[0].trim();

    // A rewrite that comes back empty, or wildly longer than the question plus
    // its context, is more likely a model wandering than a better query.
    if (!out || out.length > question.length + 400) {
      return { query: question, rewritten: false, reason: 'implausible rewrite' };
    }

    log?.log?.(`[rewrite] "${question}" -> "${out}"`);
    // usage travels with the result so the question's full cost can be
    // reported — a rewrite is a second billed call, small but not free.
    return {
      query: out, rewritten: out !== question, reason: 'rewritten', original: question,
      usage: res.usage, model,
    };
  } catch (err) {
    // Never fail a chat because the rewrite failed.
    log?.log?.(`[rewrite] failed, using the original question: ${err.message}`);
    return { query: question, rewritten: false, reason: 'error' };
  }
}
