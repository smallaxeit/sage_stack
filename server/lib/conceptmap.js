/**
 * conceptmap.js — build a subject's concept map from its stored chunks.
 *
 * Replaces the standalone rebuild-concepts.js, which read a Supabase-era
 * knowledge-base.json and hardcoded "a scholar of comparative theology and
 * philosophy" into the prompt — wrong for any subject that isn't theology.
 *
 * The map is an aggregation, not a re-reading: it works from the concepts and
 * themes that per-chunk analysis already extracted, so it costs a handful of
 * calls rather than one per chunk.
 *
 * Opt-in per subject (`conceptMap.enabled`). It earns its cost across theology
 * and philosophy, where cross-tradition relationships are the point; for a
 * single service manual it is expensive noise, and it is injected into every
 * request's system prompt, so it is a per-query cost too.
 */

const MAX_CONCEPTS = 150;
const MAX_ARGUMENTS = 60;

/** Frequency-rank the concepts and themes the analysis pass produced. */
export function summariseCorpus(chunks) {
  const conceptFreq = new Map();
  const themeFreq = new Map();
  const sources = new Set();
  const args = [];

  for (const c of chunks) {
    sources.add(c.source);
    for (const x of c.concepts || []) conceptFreq.set(x, (conceptFreq.get(x) || 0) + 1);
    for (const x of c.themes || []) themeFreq.set(x, (themeFreq.get(x) || 0) + 1);

    // Subject-specific argument-shaped extras, if the extract block produced any.
    for (const v of Object.values(c.extras || {})) {
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item && typeof item === 'object' && (item.claim || item.reasoning)) args.push(item);
        }
      }
    }
  }

  const byFreq = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);

  return {
    sources: [...sources],
    concepts: byFreq(conceptFreq, MAX_CONCEPTS),
    themes: byFreq(themeFreq, 40),
    arguments: args.slice(0, MAX_ARGUMENTS),
    analysedChunks: chunks.filter(c => (c.concepts || []).length > 0).length,
    totalChunks: chunks.length,
  };
}

export function buildPrompt(profile, summary) {
  return `You are building a knowledge map for: ${profile.name}.
${profile.tagline ? `Subject: ${profile.tagline}\n` : ''}
Source material: ${summary.sources.join(', ')}

Concepts extracted from the material, frequency-ranked:
${JSON.stringify(summary.concepts, null, 2)}

Themes:
${JSON.stringify(summary.themes, null, 2)}
${summary.arguments.length ? `\nArguments found:\n${JSON.stringify(summary.arguments, null, 2)}\n` : ''}
Build a coherent map of this material. Return ONLY a JSON object of this shape:
{
  "coreThemes": ["string"],
  "concepts": [
    {
      "name": "string",
      "description": "string",
      "relatedConcepts": ["string"],
      "themes": ["string"]
    }
  ],
  "relationships": [
    {
      "from": "string",
      "to": "string",
      "type": "enables|contrasts_with|requires|leads_to|part_of|parallels|contradicts",
      "description": "string"
    }
  ],
  "learningPath": ["string"]
}

Describe only what the material supports. Do not invent concepts that are not
in the list above.`;
}

function parseJsonLoose(text) {
  const raw = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Build and store the concept map for one subject.
 *
 * Streams the model call: these responses run to many thousands of tokens and a
 * non-streaming request of that size risks an HTTP timeout.
 */
export async function rebuildConceptMap({ profile, store, client, onProgress = () => {} }) {
  const slug = profile.slug;

  if (!profile.conceptMap.enabled) {
    throw new Error(`Subject "${slug}" has conceptMap disabled in its profile.`);
  }
  if (store.readOnly) {
    throw new Error(`Subject "${slug}" is backed by a read-only store; its concept map cannot be written.`);
  }

  onProgress({ stage: 'read' });
  const chunks = await store.getChunks(slug);
  if (chunks.length === 0) throw new Error(`Subject "${slug}" has no chunks.`);

  const summary = summariseCorpus(chunks);
  if (summary.concepts.length === 0) {
    throw new Error(
      `Subject "${slug}" has ${chunks.length} chunks but no extracted concepts, so there is ` +
      `nothing to map. Chunks need the analysis pass (ANTHROPIC_API_KEY) before a concept map ` +
      `can be built.`,
    );
  }

  onProgress({
    stage: 'build',
    concepts: summary.concepts.length,
    analysedChunks: summary.analysedChunks,
    totalChunks: summary.totalChunks,
  });

  const model = profile.conceptMap.model || profile.chat.model;
  const stream = await client.messages.stream({
    model,
    max_tokens: 16000,
    messages: [{ role: 'user', content: buildPrompt(profile, summary) }],
  });

  let text = '';
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text;
  }

  const map = parseJsonLoose(text);
  if (!map) throw new Error('Concept map response was not valid JSON.');

  const stored = {
    coreThemes: map.coreThemes ?? [],
    concepts: map.concepts ?? [],
    relationships: map.relationships ?? [],
    learningPath: map.learningPath ?? [],
    traditions: map.traditions ?? [],
    builtAt: new Date().toISOString(),
    builtFrom: {
      chunks: summary.totalChunks,
      analysedChunks: summary.analysedChunks,
      sources: summary.sources.length,
      model,
    },
  };

  onProgress({ stage: 'store', concepts: stored.concepts.length });
  await store.saveConceptMap(slug, stored);
  return stored;
}
