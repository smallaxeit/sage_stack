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
import { resolveSearchQuery } from './rewrite.js';
import { preferRank, coverActive, matches } from './prefer.js';
import { priceMessage, totalCost, formatUSD } from './pricing.js';

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
  const defaultRetrieve = async (query, { active = [] } = {}) => {
    if (!store || !embedder) {
      throw new Error('createTeacher requires either `retrieve`, or both `store` and `embedder`');
    }
    /**
     * Small subject, whole thing in context.
     *
     * Ranking exists to choose what will not fit. When everything fits, every
     * heuristic that chooses is pure downside: a question spanning four drugs
     * had one of them ranked out entirely and the answer called it undocumented.
     *
     * It is also CHEAPER than it looks. The passages are identical for every
     * question, which makes them a stable prefix, which makes them cacheable —
     * so this reads from cache at a tenth of the input price instead of paying
     * full freight for a different ten passages each time.
     *
     * Only sound while the documents fit. Past the budget it falls back to
     * search rather than truncating, because silently dropping the tail is
     * exactly the failure this mode exists to prevent.
     *
     * The budget is in CHARACTERS because that is what can be measured without
     * a tokenizer, but the conversion is not the ~4 chars/token of ordinary
     * prose: measured on drug labeling it is 2.5, so 250k chars is already
     * ~100k tokens. Dense, number-heavy documents tokenize badly.
     *
     * Latency is the other limit, and it is reached first. Rx at 121 chunks
     * fits the window comfortably and still took 169 seconds to start
     * answering, against 23 seconds for a ranked 30. Fitting is not the same
     * as being worth sending.
     */
    if (profile.retrieval.contextMode === 'all') {
      const all = await store.getChunks(profile.slug, { limit: null });
      const chars = all.reduce((n, c) => n + (c.text?.length ?? 0), 0);
      const budget = profile.retrieval.maxContextChars ?? 250_000;
      if (chars <= budget) {
        // Tells prepare() these passages can go in the cached block. Set here
        // rather than inferred there, because the fallback below leaves the
        // mode on while the passages are no longer stable.
        all.stablePassages = true;
        return all;
      }
      log.warn?.(
        `[${profile.slug}] contextMode "all" wants ${chars} chars, over the ` +
        `${budget} budget — falling back to search. Raise retrieval.maxContextChars ` +
        `or split the subject.`,
      );
    }

    if (!guarded) {
      // Refuse a cross-model query rather than returning ranked nonsense.
      const meta = await store.getSubjectMeta(profile.slug);
      if (!meta) throw new Error(`Subject "${profile.slug}" has no built knowledge base yet.`);
      assertEmbedderMatchesSubject(embedder, { ...meta, slug: profile.slug });
      guarded = true;
    }
    const vec = await embedder.embedQuery(query);
    const { topK, filterKey, overfetch = 3, boost, coverPerTerm = 1 } = profile.retrieval;

    // With no preference configured this is an ordinary top-K.
    if (!filterKey || active.length === 0) {
      return store.searchByVector(profile.slug, vec, topK);
    }

    // Fetch wider than needed so a preferred passage ranked just outside topK
    // can still be pulled in. Re-ranking a list that was already truncated
    // could not recover it.
    const wide = await store.searchByVector(profile.slug, vec, topK * overfetch);
    const ranked = preferRank(wide, { key: filterKey, active, boost, limit: topK });

    // Then guarantee each listed item a passage, so an item with many pages
    // cannot take every slot and leave another looking undocumented.
    const { results, uncovered } = coverActive(ranked, wide, {
      key: filterKey, active, limit: coverPerTerm,
    });

    // Anything absent from the whole pool gets its own search. The pool is
    // ranked against the question alone, and a question worded for one drug
    // embeds nowhere near another's pages — which says nothing about whether
    // those pages exist. One extra embedding per missing item, only when one
    // is actually missing.
    for (const term of uncovered) {
      try {
        const termVec = await embedder.embedQuery(`${term} — ${query}`);
        const hits = await store.searchByVector(profile.slug, termVec, topK);
        const hit = hits.find(h => matches(h, filterKey, [term]) && !results.some(r => r.id === h.id));
        if (hit) results.push({ ...hit, preferred: true, coveredFor: term });
      } catch (err) {
        // Coverage is an improvement on the answer, never a precondition for
        // getting one.
        log.warn?.(`[${profile.slug}] coverage search for "${term}" failed: ${err.message}`);
      }
    }

    return results;
  };

  /**
   * What the reader has nominated as currently relevant — for Rx, the drugs
   * they are taking. Read per request rather than cached: it is changed from
   * the UI mid-conversation and must take effect on the next question.
   */
  async function activeTerms() {
    if (!store?.getSettings) return [];
    try {
      const settings = await store.getSettings(profile.slug);
      const list = settings?.[profile.retrieval.filterKey];
      return Array.isArray(list) ? list.filter(x => typeof x === 'string' && x.trim()) : [];
    } catch {
      return [];   // settings are an enhancement; never fail a question over them
    }
  }

  const doRetrieve = retrieve || defaultRetrieve;

  async function prepare(messages, mode) {
    // Retrieval embeds ONE string while the model sees the whole conversation,
    // so a follow-up like "what about the rear one?" would otherwise be
    // embedded with no subject at all. Rewriting restores the missing context
    // before the vector search, and falls back to the raw question on any
    // failure — retrieval must never depend on it.
    // Rewriting exists to aim a vector search. With contextMode "all" there is
    // no search to aim, so it would be a model call and a round-trip of latency
    // bought for nothing.
    const rewriteClient =
      profile.retrieval.rewriteFollowUps === false || profile.retrieval.contextMode === 'all'
        ? null
        : (client || defaultClient());

    const {
      query, rewritten, original,
      usage: rewriteUsage, model: rewriteModel,
    } = await resolveSearchQuery({ messages, client: rewriteClient, log });

    // Resolved once per question and passed to retrieval, rather than read
    // again there — it is a store round-trip, and both callers want the same
    // answer for the same question.
    const active = profile.retrieval.filterKey ? await activeTerms() : [];
    const results = await doRetrieve(query, { active });

    log.log?.(
      `[${profile.slug}] query: "${String(query).slice(0, 80)}"` +
      (rewritten ? ` (rewritten from "${String(original).slice(0, 50)}")` : '') +
      ` -> ${results.length} chunks`,
    );

    const conceptMap = profile.conceptMap.enabled && store
      ? await store.getConceptMap(profile.slug)
      : null;

    const ctx = buildContext(profile, results);
    // Only ask for page citations when the retrieved passages actually have
    // pages; otherwise the model invents them (see subjects.js CITE_PAGES_RULES).
    const hasPages = results.some(r => r.pdfPage != null);
    const stable = buildSystemPrompt(profile, { mode, conceptMap, hasPages });

    // The active list goes in the VARYING block, not the cached prefix — it
    // changes independently of the subject, and putting it in the prefix would
    // invalidate the cache every time the reader edited their list.
    const activeNote = active.length
      ? `

THE READER'S CURRENT ${String(profile.retrieval.filterKey).toUpperCase()}: ` +
        `${active.join(', ')}.
` +
        `A question without a stated subject is about these. Questions about anything ` +
        `else are still fair — asking whether to add or avoid something is the point.
`
      : '';

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
    // When the passages are the whole subject they do not vary either, so they
    // belong INSIDE the cached prefix — that is where the saving comes from.
    // The reader's list still varies and stays behind it.
    const systemBlocks = (results.stablePassages
      ? [
          { type: 'text', text: stable + ctx.contextStr, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: activeNote },
        ]
      : [
          { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: activeNote + ctx.contextStr },
        ]
    ).filter(b => b.text);   // an empty text block is an API error

    // Billed before the answer even starts. Carried forward so the cost the
    // reader sees is the cost of the question, not just of the completion.
    const priorCosts = rewriteUsage ? [priceMessage(rewriteModel, rewriteUsage)] : [];

    return {
      ...ctx, systemBlocks, activeTerms: active, priorCosts,
      systemPrompt: stable + activeNote + ctx.contextStr,
    };
  }

  /**
   * What this question cost: the answer, plus anything billed on the way to it.
   *
   * Shown to the reader because the number is not intuitive — the same question
   * against the same subject varies by 10x on whether the cached prefix was
   * still warm, and nothing else in the answer reveals that.
   *
   * The query embedding is left out: at Voyage rates a question embeds for
   * about a millionth of a dollar, and the embedder reports no token count, so
   * including it would mean inventing a number to add nothing.
   */
  function questionCost(priorCosts = [], usage) {
    const answer = priceMessage(profile.chat.model, usage);
    const total = totalCost([...priorCosts, answer]);
    if (!total.calls.length) return null;   // no price on file; say nothing

    return {
      usd: total.usd,
      display: formatUSD(total.usd),
      complete: total.complete,
      cacheHit: answer?.cacheHit ?? false,
      model: profile.chat.model,
      tokens: answer?.tokens ?? null,
      // A second call means a rewrite happened, which is worth being able to see.
      calls: total.calls.length,
    };
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

    // Exposed so what will be sent can be inspected — passage coverage, block
    // split, cache markers — without paying for a completion to see it.
    prepare,

    async chat(messages, { mode = 'deep' } = {}) {
      const { systemBlocks, sources, chips, analytics, priorCosts } = await prepare(messages, mode);
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
        cost: questionCost(priorCosts, response.usage),
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
      const { systemBlocks, sources, chips, analytics, priorCosts } = await prepare(messages, mode);
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
      return {
        text, sources, chips, analytics,
        outputTokens: final?.usage?.output_tokens ?? 0,
        cost: questionCost(priorCosts, final?.usage),
      };
    },
  };
}
