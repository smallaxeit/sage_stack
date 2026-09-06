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

/**
 * Hard ceiling on how much of one chunk reaches the prompt.
 *
 * Ingestion caps chunks at profile.ingest.chunkMax, but IMPORTED corpora carry
 * whatever chunking they were built with. The theology import contained a
 * single 1.24 MB chunk — the whole of Plato's Republic as one row, from an
 * older pipeline whose paragraph splitting had failed. Retrieved, it put
 * ~310,000 tokens into one request: roughly $0.62 a question, and it drowned
 * the nine genuine passages beside it.
 *
 * 12,000 chars is several times any sane chunk and still bounds the damage.
 * Truncation is visible in the prompt rather than silent, because a chunk
 * hitting this is a data problem worth noticing, not something to paper over.
 */
const MAX_CHUNK_CHARS = 12000;

function chunkText(chunk) {
  const t = chunk.text ?? '';
  if (t.length <= MAX_CHUNK_CHARS) return t;
  return t.slice(0, MAX_CHUNK_CHARS) +
    `\n\n[… passage truncated: ${t.length.toLocaleString()} characters, far beyond a normal chunk. ` +
    `Treat it as partial, and do not assume the rest supports a claim.]`;
}

export function buildContext(profile, results) {
  const contextStr = results.length
    ? '\n\nRELEVANT SOURCE PASSAGES:\n' + results.map(r => {
        const meta = metaLine(r);
        return `[${friendlySourceName(profile, r.source)}${pageLabel(r)}${meta ? ' — ' + meta : ''}]\n${chunkText(r)}`;
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
    // Only ask for page citations when the retrieved passages actually have
    // pages; otherwise the model invents them (see subjects.js CITE_PAGES_RULES).
    const hasPages = results.some(r => r.pdfPage != null);
    const stable = buildSystemPrompt(profile, { mode, conceptMap, hasPages });

    /**
     * The system prompt is sent as TWO blocks so the first can be cached.
     *
     * The split is exact: everything before the retrieved passages — voice,
     * rules, grounding, and the concept map — is byte-identical for every
     * question in a subject and mode. The passages differ every time. That is
     * precisely the prefix shape prompt caching wants.
     *
     * It is worth real money here: theology's stable half is ~4,500 tokens,
     * ~3,600 of it concept map, resent on every single question.
     *
     * Caching is a PREFIX match, so anything that varies must stay in the
     * second block. Nothing time- or request-dependent may be added above it.
     */
    const systemBlocks = [
      { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: ctx.contextStr },
    ];

    return { ...ctx, systemBlocks, systemPrompt: stable + ctx.contextStr };
  }

  /** Report cache effectiveness — zero reads across repeats means a silent invalidator. */
  function logCache(usage) {
    if (!usage) return;
    const read = usage.cache_read_input_tokens ?? 0;
    const written = usage.cache_creation_input_tokens ?? 0;
    if (read || written) {
      log.log?.(`[${profile.slug}] cache: ${read} read, ${written} written, ${usage.input_tokens ?? 0} uncached`);
    }
  }

  return {
    profile,

    async chat(messages, { mode = 'deep' } = {}) {
      const { systemBlocks, sources, chips, analytics } = await prepare(messages, mode);
      const response = await (client || defaultClient()).messages.create({
        model: profile.chat.model,
        max_tokens: profile.chat.maxTokens,
        system: systemBlocks,
        messages,
      });
      logCache(response.usage);
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      return {
        text, sources, chips, analytics,
        outputTokens: response.usage?.output_tokens ?? 0,
        usage: response.usage,
      };
    },

    /**
     * `onStage` reports what is happening before any token exists. Retrieval
     * plus a cold model call can be 5-30 seconds of silence, which is
     * indistinguishable from a hang — and on a proxied dev server, long enough
     * to look like a dropped connection.
     */
    async chatStream(messages, onChunk, { mode = 'deep', onStage = () => {} } = {}) {
      onStage('retrieving');
      const { systemBlocks, sources, chips, analytics } = await prepare(messages, mode);
      onStage('thinking');
      const stream = await (client || defaultClient()).messages.stream({
        model: profile.chat.model,
        max_tokens: profile.chat.maxTokens,
        system: systemBlocks,
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
      logCache(final?.usage);
      return { text, sources, chips, analytics, outputTokens: final?.usage?.output_tokens ?? 0 };
    },
  };
}
