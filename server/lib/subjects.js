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
 * Behavioural rules that are not subject-specific. A profile may override
 * `rules` wholesale, but the default is deliberately domain-neutral so a
 * service-manual subject inherits something sane instead of theology's framing.
 */
export const DEFAULT_RULES = `HOW TO ANSWER:
- Answer the question first, directly and specifically. Don't hedge or gatekeep.
- Cite the specific source your answer draws from.
- Correct mistaken premises factually, without moralising.
- Accept questions in any tone — casual, blunt, confused, skeptical.
- If the sources don't address the question, say so plainly rather than guessing.

CITING PAGES:
- When a passage you use shows a page number, cite it inline as [p.419] —
  square brackets, lowercase p, a dot, then the page number from the passage
  header. The reader's interface turns that exact form into a link that opens
  the page, so the format matters.
- Cite the page from the passage header, not the printed label, when they differ.
- Cite at the point the fact appears, not in a list at the end.
- Never invent a page number. If a passage carries none, cite it by name instead.`;

export const DEFAULT_GROUNDING =
  'You draw ONLY from the source passages provided in context below. ' +
  'If the sources do not address the question, say so plainly.';

export const DEFAULT_MODES = {
  quick: 'RESPONSE MODE: Quick. Concise, accessible 1–2 paragraph answer. Plain language, no jargon unless essential.',
  deep:  'RESPONSE MODE: Deep. Full treatment — context, analysis, and nuance.',
};

const DEFAULTS = {
  name:          null,        // falls back to slug
  voice:         null,        // REQUIRED
  ingest:        { mode: 'auto', chunkTarget: 1400, chunkMax: 2200 },
  embed:         { driver: 'voyage', model: 'voyage-3.5', dim: 1024 },
  chat:          { model: 'claude-sonnet-5', maxTokens: 4096 },
  extract:       {},
  conceptMap:    { enabled: false },
  retrieval:     { topK: 10 },
  sourceAliases: {},           // filename -> human-readable title
  store:         null,         // null = use the app-wide KB_STORE; else a per-subject backend
  rules:         DEFAULT_RULES,
  grounding:     DEFAULT_GROUNDING,
  modes:         DEFAULT_MODES,
};

function fail(slug, msg) {
  throw new Error(`subject "${slug}": ${msg}`);
}

/** Merge a raw subject.json over the defaults and validate the result. */
export function normaliseProfile(slug, raw = {}) {
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
    grounding:     raw.grounding ?? DEFAULT_GROUNDING,
  };

  if (typeof p.voice !== 'string' || !p.voice.trim()) {
    fail(slug, 'a non-empty "voice" is required — it is the teaching persona for this subject');
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
  return normaliseProfile(slug, raw);
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
export function buildSystemPrompt(profile, { mode = 'deep', conceptMap = null } = {}) {
  const modeInstruction = profile.modes[mode] || profile.modes.deep || DEFAULT_MODES.deep;
  return [
    profile.voice.trim(),
    renderConceptMap(profile, conceptMap),
    profile.rules.trim(),
    profile.grounding.trim(),
    modeInstruction.trim(),
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
