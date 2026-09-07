/**
 * ingest/vision.js — read a scanned page with a vision model.
 *
 * Why this exists, in one line: for a scanned document, text extraction
 * returns nothing and OCR mangles exactly what matters. ask_cooter measured it
 * on a 651-page manual — ~0 extractable characters — and plain OCR reads body
 * text acceptably while destroying the torque tables, exploded diagrams and
 * wiring schematics that are the entire value of the thing.
 *
 * So the page is rendered and looked at. Answer quality is bounded by
 * ingestion quality, which is why the money goes here rather than into the
 * vector layer.
 *
 * Resilience follows ask_cooter's design, for reasons it learned the hard way:
 * a run of several hundred vision calls WILL hit rate limits, transient 529s,
 * and occasional content-filter false positives. Each page is therefore an
 * independent unit — rendered, read, and stored on its own — so an interrupted
 * run resumes instead of restarting, and one bad page never sinks the batch.
 */

import { purposeConfig, modelConfig } from '../models.js';
import { priceMessage } from '../pricing.js';

const { model: DEFAULT_MODEL, fallback: FALLBACK_MODEL } = purposeConfig('vision');
const VISION_ESTIMATE = modelConfig().visionEstimate;

/** Substrings marking a failure worth retrying rather than surfacing. */
const RETRYABLE = [
  'rate limit', 'rate_limit', 'overloaded', 'timeout', 'timed out',
  'content filter', 'blocked', 'refus', '429', '500', '502', '503', '529',
];

const isRetryable = (err) => {
  const m = String(err?.message ?? err).toLowerCase();
  return RETRYABLE.some(x => m.includes(x));
};

/**
 * The extraction prompt. Subject-specific fields come from the profile's
 * `extract` block, exactly as they do for text analysis — so a service manual
 * asks for torque specs and a medical reference asks for dosages, from the same
 * pipeline.
 */
export function buildVisionPrompt(profile, extraSchema) {
  return [
    `You are transcribing one page of: ${profile.name}.`,
    '',
    'Read the page image and return its content as structured JSON. This is a',
    'transcription task, not a summary — reproduce what is printed.',
    '',
    'Requirements:',
    '- Reproduce body text faithfully. Do not paraphrase, condense, or improve it.',
    '- Rebuild every table as a markdown table, preserving all rows and columns.',
    '  Tables are usually the most valuable thing on a page; a dropped row is a',
    '  fact silently lost.',
    '- Copy numbers, units, tolerances and ranges EXACTLY as printed, including',
    '  both metric and imperial where the page shows both.',
    '- Describe each figure or diagram in enough detail to be useful without the',
    '  image: what it shows, its callouts, and its figure number.',
    '- If the page is blank or only a header, say so with empty content rather',
    '  than inventing any.',
    '- Never guess at text you cannot read. Mark it "[illegible]".',
    '',
    'Return ONLY this JSON object:',
    '{',
    '  "printedPage": "the page number printed on the page, or null",',
    '  "section": "the running header or section title, or null",',
    '  "markdown": "the full page content as markdown, tables included",',
    '  "isBlank": false,',
    extraSchema ? extraSchema + ',' : '',
    '  "componentTags": ["lowercase topics this page covers"]',
    '}',
  ].filter(l => l !== '').join('\n');
}

function parseJsonLoose(text) {
  const raw = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch { /* fall through */ }
  // A truncated or chatty reply sometimes still contains a complete object.
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch { /* give up */ }
  }
  return null;
}

/** One vision call. Throws on failure so the caller can decide about retrying. */
async function callVision({ client, model, png, prompt, maxTokens }) {
  const res = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  if (res.stop_reason === 'refusal') {
    throw new Error(`refusal: ${res.stop_details?.category ?? 'unspecified'}`);
  }

  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const parsed = parseJsonLoose(text);
  if (!parsed) throw new Error('vision reply was not valid JSON');
  return { parsed, usage: res.usage };
}

/**
 * Extract one page, retrying and then falling back to the other model tier.
 *
 * The fallback is not redundancy for its own sake: a page that trips a content
 * filter or defeats one model often succeeds on the other, and re-running an
 * entire ingest for a handful of pages is the expensive outcome.
 */
export async function extractPage({
  client, profile, png, pdfPage,
  model = DEFAULT_MODEL,
  fallbackModel = FALLBACK_MODEL,
  maxTokens = 8000,
  extraSchema = '',
  attemptsPerModel = 2,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
} = {}) {
  const prompt = buildVisionPrompt(profile, extraSchema);
  const models = model === fallbackModel ? [model] : [model, fallbackModel];

  let lastErr = null;
  for (const m of models) {
    for (let attempt = 0; attempt < attemptsPerModel; attempt++) {
      try {
        const { parsed, usage } = await callVision({ client, model: m, png, prompt, maxTokens });
        const { printedPage, section, markdown, isBlank, componentTags, ...extras } = parsed;
        return {
          pdfPage,
          printedPage: printedPage ?? null,
          section: section ?? null,
          markdown: typeof markdown === 'string' ? markdown : '',
          isBlank: !!isBlank,
          componentTags: Array.isArray(componentTags) ? componentTags : [],
          extras,
          model: m,
          recovered: m !== model,
          usage,
        };
      } catch (err) {
        lastErr = err;
        // A malformed request or a bad key will not fix itself — not on a
        // retry, and not on the other model either. Surface it now rather than
        // spending a second call to reach the same failure.
        if (!isRetryable(err)) {
          const fatal = new Error(`page ${pdfPage + 1}: ${err.message}`);
          fatal.pdfPage = pdfPage;
          fatal.cause = err;
          throw fatal;
        }
        await sleep(1500 * (attempt + 1));
      }
    }
  }

  const e = new Error(`page ${pdfPage + 1}: ${lastErr?.message ?? 'extraction failed'}`);
  e.pdfPage = pdfPage;
  e.cause = lastErr;
  throw e;
}

/**
 * Rough cost estimate before committing to a run.
 *
 * Vision input is dominated by the image. A 150-DPI page is on the order of
 * 1,500 tokens; output varies with how dense the page is. Deliberately an
 * over-estimate — the useful error here is being pleasantly surprised.
 */
export function estimateVisionCost(pages, {
  inPerPage = VISION_ESTIMATE.inputTokensPerPage,
  outPerPage = VISION_ESTIMATE.outputTokensPerPage,
  model = DEFAULT_MODEL,
} = {}) {
  // Priced by the same table the chat path uses. This function used to carry
  // its own, which quoted Sonnet at $2/$10 against the real $3/$15 — every
  // vision estimate was a third low.
  const priced = priceMessage(model, {
    input_tokens: pages * inPerPage,
    output_tokens: pages * outPerPage,
  });
  const usd = priced?.usd ?? 0;
  return { pages, model, usd, perPage: usd / Math.max(1, pages), priced: !!priced };
}
