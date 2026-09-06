/**
 * claude.js — retrieval-augmented answering, per subject.
 *
 * Everything subject-specific now comes from a profile (see subjects.js): the
 * voice, the response modes, the concept map, topK, source aliases, and the
 * model. Nothing theology-shaped remains hardcoded here.
 *
 * Dependencies are injected rather than imported, so a teacher can be built
 * against fakes in tests and against the real store/embedder in the server:
 *
 *   const teacher = createTeacher({ profile, store, embedder });
 *   await teacher.chatStream(messages, onChunk, { mode: 'deep' });
 *
 * Retrieval is subject-scoped at every step — the store is asked for
 * profile.slug and nothing else, which is the tenancy guarantee from §10.
 */

import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, friendlySourceName } from './subjects.js';
import { assertEmbedderMatchesSubject } from './embed/index.js';

let _client = null;
function defaultClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/**
 * Render a retrieved chunk's metadata line. Generic across subjects: concepts
 * plus whatever string-array fields the subject's `extract` block produced.
 * Theology contributes scriptureRefs here; a manual contributes componentTags.
 */
function metaLine(chunk) {
  const parts = [];
  if (chunk.concepts?.length) parts.push(`Concepts: ${chunk.concepts.join(', ')}`);
  for (const [field, value] of Object.entries(chunk.extras || {})) {
    if (Array.isArray(value) && value.length && value.every(v => typeof v === 'string')) {
      parts.push(`${field}: ${value.join(', ')}`);
    }
  }
  return parts.join(' | ');
}

/** Page citation, when the subject's ingestion produced page numbers. */
function pageLabel(chunk) {
  if (chunk.pdfPage == null) return '';
  const printed = chunk.printedPage ? ` (printed ${chunk.printedPage})` : '';
  return ` p.${chunk.pdfPage + 1}${printed}`;
}

export function buildContext(profile, results) {
  const contextStr = results.length
    ? '\n\nRELEVANT SOURCE PASSAGES:\n' + results.map(r => {
        const meta = metaLine(r);
        return `[${friendlySourceName(profile, r.source)}${pageLabel(r)}${meta ? ' — ' + meta : ''}]\n${r.text}`;
      }).join('\n\n---\n\n')
    : '\n\nNo closely matching passages found. Say so plainly rather than answering from outside the sources.';

  // Deduplicated source list for the citation panel.
  const sourceMap = new Map();
  for (const r of results) {
    if (!sourceMap.has(r.source)) {
      sourceMap.set(r.source, {
        source: friendlySourceName(profile, r.source),
        // Raw filename too: the friendly title is for reading, this is what the
        // page viewer needs to fetch the actual document.
        filename: r.source,
        page: r.pdfPage == null ? null : r.pdfPage + 1,
        printedPage: r.printedPage ?? null,
        preview: r.text.slice(0, 160).replace(/\n/g, ' '),
      });
    }
  }

  // Explore chips: concepts first, then subject-specific string arrays.
  const seen = new Set();
  const chips = [];
  for (const r of results) {
    const candidates = [...(r.concepts || [])];
    for (const value of Object.values(r.extras || {})) {
      if (Array.isArray(value)) candidates.push(...value.filter(v => typeof v === 'string'));
    }
    for (const c of candidates) {
      if (c && !seen.has(c) && chips.length < 6) { seen.add(c); chips.push(c); }
    }
  }

  const analytics = {
    subjects: [...new Set(results.flatMap(r => r.concepts || []))].slice(0, 20),
    themes:   [...new Set(results.flatMap(r => r.themes   || []))].slice(0, 10),
    chunkRefs: results.map(r => ({ id: r.id, source: r.source, chunkIndex: r.chunkIndex })),
  };

  return { contextStr, sources: [...sourceMap.values()], chips, analytics };
}

/**
 * Build a teacher bound to one subject.
 *
 * `retrieve` may be supplied directly (tests, or a custom ranking); otherwise
 * one is derived from `store` + `embedder`, with the embedding-compatibility
 * guard applied once on first use.
 */
export function createTeacher({ profile, store, embedder, retrieve, client, log = console } = {}) {
  if (!profile) throw new Error('createTeacher requires a subject profile');

  let guarded = false;
  const defaultRetrieve = async (query) => {
    if (!store || !embedder) {
      throw new Error('createTeacher requires either `retrieve`, or both `store` and `embedder`');
    }
    if (!guarded) {
      // Refuse a cross-model query rather than returning ranked nonsense.
      const meta = await store.getSubjectMeta(profile.slug);
      if (!meta) throw new Error(`Subject "${profile.slug}" has no built knowledge base yet.`);
      assertEmbedderMatchesSubject(embedder, { ...meta, slug: profile.slug });
      guarded = true;
    }
    const vec = await embedder.embedQuery(query);
    return store.searchByVector(profile.slug, vec, profile.retrieval.topK);
  };

  const doRetrieve = retrieve || defaultRetrieve;

  async function prepare(messages, mode) {
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const results = await doRetrieve(lastUserMessage);

    log.log?.(`[${profile.slug}] query: "${String(lastUserMessage).slice(0, 80)}" -> ${results.length} chunks`);

    const conceptMap = profile.conceptMap.enabled && store
      ? await store.getConceptMap(profile.slug)
      : null;

    const ctx = buildContext(profile, results);
    return { ...ctx, systemPrompt: buildSystemPrompt(profile, { mode, conceptMap }) + ctx.contextStr };
  }

  return {
    profile,

    async chat(messages, { mode = 'deep' } = {}) {
      const { systemPrompt, sources, chips, analytics } = await prepare(messages, mode);
      const response = await (client || defaultClient()).messages.create({
        model: profile.chat.model,
        max_tokens: profile.chat.maxTokens,
        system: systemPrompt,
        messages,
      });
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      return { text, sources, chips, analytics, outputTokens: response.usage?.output_tokens ?? 0 };
    },

    async chatStream(messages, onChunk, { mode = 'deep' } = {}) {
      const { systemPrompt, sources, chips, analytics } = await prepare(messages, mode);
      const stream = await (client || defaultClient()).messages.stream({
        model: profile.chat.model,
        max_tokens: profile.chat.maxTokens,
        system: systemPrompt,
        messages,
      });

      let text = '';
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          text += event.delta.text;
          onChunk(event.delta.text);
        }
      }
      const final = await stream.finalMessage();
      return { text, sources, chips, analytics, outputTokens: final?.usage?.output_tokens ?? 0 };
    },
  };
}
