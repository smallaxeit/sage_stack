/**
 * subjects.js — subject profiles (ARCHITECTURE_PLAN.md §5).
 *
 * A subject is a directory. Adding one touches no code:
 *
 *   subjects/theology/subject.json   source/*.pdf
 *   subjects/medicine/subject.json   source/*.pdf
 *   subjects/softail/subject.json    source/*.pdf
 *
 * subject.json carries everything that used to be hardcoded — the teaching
 * voice, the chunking parameters, the embedding model, and the subject-specific
 * metadata fields to extract. Theology's "scriptureRefs" and a service manual's
 * "torqueSpecs" are the same mechanism with different config.
 *
 * Subjects are TENANTS (§10): a profile is scoped data, and `slug` is validated
 * by the same guard the store uses, because it becomes a directory name and a
 * SQL identifier.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertValidSlug } from './store/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../..');

export const INGEST_MODES  = ['auto', 'text', 'vision'];
export const EMBED_DRIVERS = ['voyage', 'local'];

/**
 * Behavioral rules that are not subject-specific. A profile may override
 * `rules` wholesale, but the default is deliberately domain-neutral so a
 * service-manual subject inherits something sane instead of theology's framing.
 */
export const DEFAULT_RULES = `HOW TO ANSWER:
- Answer the question first, directly and specifically. Don't hedge or gatekeep.
- Cite the specific source your answer draws from.
- Correct mistaken premises factually, without moralising.
- Accept questions in any tone — casual, blunt, confused, skeptical.
- If the sources don't address the question, say so plainly rather than guessing.
`;

/**
 * Grounding modes — how far outside the retrieved passages an answer may go.
 *
 * This exists because "draw only from the sources" is not self-enforcing. A
 * voice that asks for "the full picture: names, dates, historical context"
 * will supply them from training data and then disclaim them, which reads as
 * authoritative and is exactly the failure worth preventing: the reader gets
 * unsourced specifics they have no way to check.
 *
 * Naming a thing to say you cannot discuss it still puts the claim in front of
 * the reader, so `strict` forbids that explicitly rather than trusting a
 * general instruction to cover it.
 */
export const GROUNDING_MODES = {
  strict: `GROUNDING — STRICT. This is the controlling instruction and overrides any
part of your persona that conflicts with it.

- Everything factual in your answer must come from the passages below. Not from
  what you know about this subject generally.
- Do NOT name specific external works, authors, councils, dates, events or
  figures that are absent from the passages — not even to say they are absent,
  and not even as helpful background. Naming them still puts unsourced claims
  in front of the reader as though they were established.
- Do not estimate, infer, or reconstruct specifics — numbers, dates, sequences,
  attributions — that the passages do not state.

WHAT YOU MAY SAY ABOUT COVERAGE — read this carefully:
- The passages below are the handful retrieved for THIS question. They are not
  the whole collection, and you cannot see the rest of it.
- So never say a text, book or topic "is not in" the collection, "isn't
  included", or "doesn't exist here". You have no way to know that, and saying
  it produces confident false denials about material that is present.
- Say only what is true: "the passages I have here don't cover that". Then
  invite a narrower question, because a different question retrieves different
  passages.
- If the reader says something IS in the collection, believe them. They can see
  what was loaded and you cannot. Ask them to point you at it rather than
  contradicting them.`,

  grounded: `GROUNDING — SOURCED. Your answer comes from the passages below.

- The substance of the answer must come from the passages.
- You may use general knowledge only to define a term or give one sentence of
  orienting context, and you must mark it plainly — "outside the loaded
  sources" — so the reader can tell the difference.
- Never present unsourced specifics (dates, named works, attributions) as
  though they came from the material.
- The passages are the few retrieved for this question, not the whole
  collection. Say "the passages I have here don't cover that" — never that
  something "is not in" the collection, which you cannot see and cannot know.`,

  open: `GROUNDING — OPEN. The passages below are your primary material, but you may
draw on general knowledge where it genuinely helps.

- Lead with what the passages support, and cite it.
- Clearly distinguish anything from general knowledge from what the sources
  say — the reader must always be able to tell which is which.
- Flag where general knowledge is contested or where you are uncertain.`,
};

export const DEFAULT_GROUNDING_MODE = 'grounded';

/** Back-compat: `grounding` used to be a plain instruction string. */
export const DEFAULT_GROUNDING = GROUNDING_MODES[DEFAULT_GROUNDING_MODE];

/**
 * Page-citation instructions, chosen per request rather than baked into the
 * prompt.
 *
 * This is not a nicety. Asking for [p.N] when the retrieved passages carry no
 * page numbers makes the model invent them: it complies with the format because
 * the format was requested, and produces citations that look authoritative,
 * render as links, and point at nothing. Observed directly — a theology answer
 * cited eleven pages from a corpus where not one chunk has a page number.
 *
 * So the instruction is only given when the context can actually support it,
 * and its absence is stated explicitly rather than left silent.
 */
export const CITE_PAGES_RULES = `CITING PAGES:
- The passages below carry page numbers in their headers. Cite them inline as
  [p.419] — square brackets, lowercase p, a dot, then the number from the header.
  The reader's interface turns that exact form into a link that opens the page,
  so the format matters.
- Use the page from the header, not the printed label, when the two differ.
- Cite at the point the fact appears, not in a list at the end.
- Only cite a page that appears in a passage header below. Never infer or
  estimate one.`;

export const NO_PAGES_RULES = `CITING SOURCES:
- The passages below have NO page numbers. Do not write [p.N] or any page
  citation — there is no page to point at and a reader would be sent nowhere.
- Cite by the name of the text instead, and by its own internal divisions where
  it has them (chapter, book, surah, verse), which are visible in the passage.`;

export const DEFAULT_MODES = {
  quick: 'RESPONSE MODE: Quick. Concise, accessible 1–2 paragraph answer. Plain language, no jargon unless essential.',
  deep:  'RESPONSE MODE: Deep. Full treatment — context, analysis, and nuance.',
};

const DEFAULTS = {
  name:          null,        // falls back to slug
  voice:         null,        // REQUIRED
  ingest:        { mode: 'auto', chunkTarget: 1400, chunkMax: 2200, keepOriginal: true, visionModel: null, renderScale: 2 },
  embed:         { driver: 'voyage', model: 'voyage-3.5', dim: 1024 },
  chat:          { model: 'claude-sonnet-5', maxTokens: 4096 },
  extract:       {},
  conceptMap:    { enabled: false },
  retrieval:     { topK: 10, rewriteFollowUps: true, filterKey: null, overfetch: 3, boost: 0.12 },
  sourceAliases: {},           // filename -> human-readable title
  store:         null,         // null = use the app-wide KB_STORE; else a per-subject backend
  rules:         DEFAULT_RULES,
  grounding:     DEFAULT_GROUNDING,
  modes:         DEFAULT_MODES,
};

function fail(slug, msg) {
  throw new Error(`subject "${slug}": ${msg}`);
}

/**
 * Grounding config accepts three shapes:
 *
 *   omitted                          -> the default mode
 *   "some instruction text"          -> legacy: used verbatim as the instruction
 *   { mode, instruction? }           -> a named mode, optionally with extra text
 *
 * The legacy string form is kept working because it is what the first
 * subject.json files used, and silently changing their behavior would be
 * worse than carrying the shape.
 */
export function normalizeGrounding(raw) {
  if (raw == null) return { mode: DEFAULT_GROUNDING_MODE, instruction: null };
  if (typeof raw === 'string') return { mode: 'custom', instruction: raw };
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return { mode: raw.mode || DEFAULT_GROUNDING_MODE, instruction: raw.instruction ?? null };
  }
  return { mode: DEFAULT_GROUNDING_MODE, instruction: null };
}

/** The prompt text for a subject's grounding setting. */
export function renderGrounding(profile) {
  const g = profile.grounding;
  const base = g.mode === 'custom' ? '' : (GROUNDING_MODES[g.mode] || GROUNDING_MODES[DEFAULT_GROUNDING_MODE]);
  return [base, g.instruction].filter(Boolean).join('\n\n').trim();
}

/** Merge a raw subject.json over the defaults and validate the result. */
export function normalizeProfile(slug, raw = {}) {
  assertValidSlug(slug);

  if (raw.slug && raw.slug !== slug) {
    fail(slug, `subject.json declares slug "${raw.slug}" but lives in directory "${slug}"`);
  }

  const p = {
    ...DEFAULTS,
    ...raw,
    slug,
    name:       raw.name || slug,
    ingest:        { ...DEFAULTS.ingest,     ...(raw.ingest     || {}) },
    embed:         { ...DEFAULTS.embed,      ...(raw.embed      || {}) },
    chat:          { ...DEFAULTS.chat,       ...(raw.chat       || {}) },
    conceptMap:    { ...DEFAULTS.conceptMap, ...(raw.conceptMap || {}) },
    retrieval:     { ...DEFAULTS.retrieval,  ...(raw.retrieval  || {}) },
    modes:         { ...DEFAULTS.modes,      ...(raw.modes      || {}) },
    extract:       raw.extract || {},
    sourceAliases: raw.sourceAliases || {},
    store:         raw.store || null,
    rules:         raw.rules ?? DEFAULT_RULES,
    grounding:     normalizeGrounding(raw.grounding),
  };

  if (typeof p.voice !== 'string' || !p.voice.trim()) {
    fail(slug, 'a non-empty "voice" is required — it is the teaching persona for this subject');
  }
  if (p.ingest.visionModel != null && typeof p.ingest.visionModel !== 'string') {
    fail(slug, 'ingest.visionModel must be a model id string, or null for the default');
  }
  if (!Number.isFinite(p.ingest.renderScale) || p.ingest.renderScale <= 0) {
    fail(slug, 'ingest.renderScale must be a positive number (2 is ~150 DPI)');
  }
  if (typeof p.ingest.keepOriginal !== 'boolean') {
    fail(slug, 'ingest.keepOriginal must be true or false');
  }
  if (!INGEST_MODES.includes(p.ingest.mode)) {
    fail(slug, `ingest.mode must be one of ${INGEST_MODES.join(', ')} (got ${JSON.stringify(p.ingest.mode)})`);
  }
  if (!EMBED_DRIVERS.includes(p.embed.driver)) {
    fail(slug, `embed.driver must be one of ${EMBED_DRIVERS.join(', ')} (got ${JSON.stringify(p.embed.driver)})`);
  }
  if (!Number.isInteger(p.embed.dim) || p.embed.dim <= 0) {
    fail(slug, `embed.dim must be a positive integer (got ${JSON.stringify(p.embed.dim)})`);
  }
  if (!Number.isInteger(p.ingest.chunkTarget) || !Number.isInteger(p.ingest.chunkMax)
      || p.ingest.chunkTarget <= 0 || p.ingest.chunkMax < p.ingest.chunkTarget) {
    fail(slug, 'ingest.chunkTarget and chunkMax must be positive integers with chunkMax >= chunkTarget');
  }
  if (p.retrieval.filterKey != null && typeof p.retrieval.filterKey !== 'string') {
    fail(slug, 'retrieval.filterKey must be the name of an extract field, or null');
  }
  if (p.retrieval.filterKey && !(p.retrieval.filterKey in p.extract)) {
    // Otherwise the reader's selection silently matches nothing, which reads
    // as "the documents do not mention that".
    fail(slug, `retrieval.filterKey "${p.retrieval.filterKey}" is not a field in extract`);
  }
  if (!Number.isInteger(p.retrieval.overfetch) || p.retrieval.overfetch < 1) {
    fail(slug, 'retrieval.overfetch must be an integer of at least 1');
  }
  if (!Number.isFinite(p.retrieval.boost) || p.retrieval.boost < 0 || p.retrieval.boost > 1) {
    fail(slug, 'retrieval.boost must be between 0 and 1');
  }
  if (typeof p.retrieval.rewriteFollowUps !== 'boolean') {
    fail(slug, 'retrieval.rewriteFollowUps must be true or false');
  }
  if (!Number.isInteger(p.retrieval.topK) || p.retrieval.topK <= 0) {
    fail(slug, `retrieval.topK must be a positive integer (got ${JSON.stringify(p.retrieval.topK)})`);
  }
  if (typeof p.chat.model !== 'string' || !p.chat.model.trim()) {
    fail(slug, 'chat.model must be a model id string');
  }
  if (!Number.isInteger(p.chat.maxTokens) || p.chat.maxTokens <= 0) {
    fail(slug, `chat.maxTokens must be a positive integer (got ${JSON.stringify(p.chat.maxTokens)})`);
  }
  if (typeof p.sourceAliases !== 'object' || Array.isArray(p.sourceAliases)) {
    fail(slug, 'sourceAliases must be an object mapping filename -> display title');
  }
  const groundingModes = [...Object.keys(GROUNDING_MODES), 'custom'];
  if (!groundingModes.includes(p.grounding.mode)) {
    fail(slug, `grounding.mode must be one of ${groundingModes.join(', ')} (got ${JSON.stringify(p.grounding.mode)})`);
  }
  if (p.grounding.instruction != null && typeof p.grounding.instruction !== 'string') {
    fail(slug, 'grounding.instruction must be a string');
  }
  if (p.grounding.mode === 'custom' && !p.grounding.instruction?.trim()) {
    fail(slug, 'a custom grounding needs instruction text');
  }

  if (p.store !== null) {
    if (typeof p.store !== 'object' || Array.isArray(p.store)) {
      fail(slug, 'store must be an object, or omitted to use the app-wide KB_STORE');
    }
    if (!p.store.driver) fail(slug, 'store.driver is required when a store block is present');
    // Connection strings are secrets and must not live in a committed profile.
    // connectionStringEnv names the environment variable holding it.
    if (p.store.connectionString && p.store.connectionStringEnv) {
      fail(slug, 'store: set connectionString OR connectionStringEnv, not both');
    }
  }
  if (typeof p.extract !== 'object' || Array.isArray(p.extract)) {
    fail(slug, 'extract must be an object mapping field name -> description');
  }
  for (const [field, desc] of Object.entries(p.extract)) {
    if (typeof desc !== 'string' || !desc.trim()) {
      fail(slug, `extract.${field} must be a non-empty description string`);
    }
  }

  return p;
}

export function subjectsRoot(opts = {}) {
  return path.resolve(opts.root || process.env.SUBJECTS_ROOT || path.join(REPO_ROOT, 'subjects'));
}

/** Absolute path to a subject's source directory (where its PDFs live). */
export function subjectSourceDir(slug, opts = {}) {
  return path.join(subjectsRoot(opts), assertValidSlug(slug), 'source');
}

export async function loadSubject(slug, opts = {}) {
  assertValidSlug(slug);
  const file = path.join(subjectsRoot(opts), slug, 'subject.json');
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`No such subject: "${slug}" (expected ${file})`);
    throw new Error(`subject "${slug}": subject.json is not valid JSON — ${err.message}`);
  }
  return normalizeProfile(slug, raw);
}

/** Every subject with a readable, valid profile. Invalid ones are reported, not thrown. */
export async function listSubjects(opts = {}) {
  const root = subjectsRoot(opts);
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { subjects: [], errors: [] };
  }

  const subjects = [];
  const errors = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try { subjects.push(await loadSubject(e.name, opts)); }
    catch (err) { errors.push({ slug: e.name, error: err.message }); }
  }
  subjects.sort((a, b) => a.slug.localeCompare(b.slug));
  return { subjects, errors };
}

// ─── Prompt assembly ──────────────────────────────────────────────────────────

/**
 * Render the concept map into a prompt section. Only subjects that opt in get
 * one — it is valuable across theology and philosophy, and expensive noise for
 * a single service manual.
 *
 * Note this is injected into EVERY request's system prompt, so it is also a
 * per-tenant cost: a manual subject should not be carrying a theology map.
 */
export function renderConceptMap(profile, conceptMap) {
  if (!profile.conceptMap.enabled || !conceptMap) return '';
  const label = profile.conceptMap.label || `${profile.name.toUpperCase()} KNOWLEDGE MAP`;
  const bar = '━'.repeat(43);
  const lines = [`\n${bar}\n${label}\n${bar}\n`];

  if (conceptMap.coreThemes?.length)  lines.push(`CORE THEMES:\n${conceptMap.coreThemes.join(', ')}\n`);
  if (conceptMap.learningPath?.length) lines.push(`SUGGESTED LEARNING PATH:\n${conceptMap.learningPath.join(' → ')}\n`);
  if (conceptMap.concepts?.length) {
    lines.push('KEY CONCEPTS AND RELATIONSHIPS:\n' + conceptMap.concepts.map(c =>
      `• ${c.name}: ${c.description}${c.relatedConcepts?.length ? ` [related: ${c.relatedConcepts.join(', ')}]` : ''}`
    ).join('\n') + '\n');
  }
  if (conceptMap.relationships?.length) {
    lines.push('CONCEPTUAL RELATIONSHIPS:\n' + conceptMap.relationships.map(r =>
      `• ${r.from} ${r.type} ${r.to}: ${r.description}`
    ).join('\n') + '\n');
  }
  lines.push(bar);
  return lines.join('\n');
}

/**
 * Assemble the full system prompt for a subject. This replaces the hardcoded
 * buildSystemPrompt() in claude.js — the shape is the same, the content is
 * entirely profile-driven.
 */
export function buildSystemPrompt(profile, { mode = 'deep', conceptMap = null, hasPages = false } = {}) {
  const modeInstruction = profile.modes[mode] || profile.modes.deep || DEFAULT_MODES.deep;
  return [
    profile.voice.trim(),
    renderConceptMap(profile, conceptMap),
    profile.rules.trim(),
    // Chosen from what was actually retrieved, not from the subject profile —
    // the same subject can hold paged and unpaged documents.
    (hasPages ? CITE_PAGES_RULES : NO_PAGES_RULES),
    modeInstruction.trim(),
    // Grounding comes LAST deliberately. It is the constraint most likely to be
    // contradicted by an expansive persona ("give the full picture: names,
    // dates, historical context"), and the last instruction in a prompt carries
    // more weight than one buried in the middle.
    renderGrounding(profile),
  ].filter(Boolean).join('\n\n');
}

/**
 * Resolve a subject's store options, reading any env-referenced secret.
 * Returns null when the subject uses the app-wide default store.
 */
export function resolveStoreConfig(profile, env = process.env) {
  const cfg = profile.store;
  if (!cfg) return null;
  const out = { ...cfg };
  // Any key ending in "Env" names an environment variable holding the real
  // value, so secrets and machine-specific paths stay out of a committed
  // profile: connectionStringEnv -> connectionString, imageDirEnv -> imageDir.
  for (const [key, name] of Object.entries(cfg)) {
    if (!key.endsWith('Env')) continue;
    const target = key.slice(0, -3);
    const value = env[name];
    if (!value) {
      throw new Error(
        `subject "${profile.slug}": store.${key} names ${name}, which is not set. ` +
        `Add it to server/.env.`,
      );
    }
    out[target] = value;
    delete out[key];
  }
  return out;
}

/**
 * Human-readable title for a source file. Subjects supply their own aliases
 * (this used to be a hardcoded theology-only map in claude.js); anything not
 * listed falls back to a tidied-up filename.
 */
export function friendlySourceName(profile, filename) {
  if (!filename) return '';
  return profile.sourceAliases?.[filename]
    || filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
}

/**
 * The subject-specific half of the chunk-analysis prompt. Turns the `extract`
 * block into JSON schema lines appended to the generic core, so theology asks
 * for scriptureRefs and a service manual asks for torque specs — same pipeline.
 */
export function renderExtractSchema(profile) {
  const entries = Object.entries(profile.extract);
  if (entries.length === 0) return '';
  return entries.map(([field, desc]) => `  "${field}": ${JSON.stringify(desc)}`).join(',\n');
}
