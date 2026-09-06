/**
 * runtime.js — the subject registry.
 *
 * Wires the three independent pieces together and caches the result:
 *
 *   subject profile  (subjects.js)  what to say, how to chunk, what to extract
 *   store            (store/)       where the bytes live: files or postgres
 *   embedder         (embed/)       how text becomes vectors: voyage or local
 *
 * Routes ask for a subject and get a ready teacher. Everything is lazy so the
 * server can start without a knowledge base, a database, or an API key — a
 * request for an unbuilt subject fails with a clear message instead of the
 * process refusing to boot.
 *
 * Tenancy (§10): a teacher is bound to exactly one subject slug for its whole
 * life. There is no path through this module that hands a route a store call
 * without a slug.
 */

import { createStore } from './store/index.js';
import { createEmbedder } from './embed/index.js';
import { loadSubject, listSubjects as listSubjectProfiles, resolveStoreConfig } from './subjects.js';
import { createTeacher } from './claude.js';

export function createRuntime(opts = {}) {
  // The default store backs any subject without its own `store` block, and
  // always backs sessions -- a subject may point at someone else's database
  // (see store/askcooter.js), and chat history must never be written there.
  const store     = opts.store || createStore(opts.storeOptions);
  const profiles  = new Map();
  const embedders = new Map();
  const teachers  = new Map();
  const stores    = new Map();   // config key -> store

  async function getProfile(slug) {
    if (!profiles.has(slug)) profiles.set(slug, await loadSubject(slug, opts.subjectOptions));
    return profiles.get(slug);
  }

  /**
   * The store backing one subject. Subjects with their own `store` block get a
   * dedicated backend, cached by configuration so two subjects pointing at the
   * same database share one pool.
   */
  function getStore(profile) {
    const cfg = resolveStoreConfig(profile);
    if (!cfg) return store;
    const key = JSON.stringify(cfg);
    if (!stores.has(key)) stores.set(key, createStore(cfg));
    return stores.get(key);
  }

  /**
   * One embedder per (driver, model, dim) rather than per subject — subjects
   * sharing a configuration share the loaded model, which matters for the local
   * driver where loading is the expensive part.
   */
  function getEmbedder(profile) {
    const key = `${profile.embed.driver}:${profile.embed.model}:${profile.embed.dim}`;
    if (!embedders.has(key)) embedders.set(key, createEmbedder(profile.embed));
    return embedders.get(key);
  }

  async function getTeacher(slug) {
    if (!teachers.has(slug)) {
      const profile = await getProfile(slug);
      teachers.set(slug, createTeacher({
        profile,
        store: getStore(profile),
        embedder: getEmbedder(profile),
      }));
    }
    return teachers.get(slug);
  }

  /**
   * Which subject to serve when a request doesn't name one.
   * DEFAULT_SUBJECT wins; otherwise, if exactly one subject exists, use it —
   * being explicit only matters once there is something to be ambiguous about.
   */
  async function defaultSubject() {
    if (process.env.DEFAULT_SUBJECT) return process.env.DEFAULT_SUBJECT;
    const { subjects } = await listSubjectProfiles(opts.subjectOptions);
    if (subjects.length === 1) return subjects[0].slug;
    if (subjects.length === 0) throw new Error('No subjects defined — add subjects/<slug>/subject.json');
    throw new Error(
      `Multiple subjects exist (${subjects.map(s => s.slug).join(', ')}) — ` +
      `the request must name one, or set DEFAULT_SUBJECT.`,
    );
  }

  /** Profiles joined to their build state. Powers the admin panel. */
  async function status() {
    const { subjects, errors } = await listSubjectProfiles(opts.subjectOptions);
    const rows = await Promise.all(subjects.map(async (p) => {
      let built = null;
      let storeError = null;
      try { built = await getStore(p).getSubjectMeta(p.slug); }
      catch (err) { storeError = err.message; }
      return {
        slug: p.slug,
        name: p.name,
        ready: !!built && built.withEmbedding > 0,
        chunks: built?.chunkCount ?? 0,
        withEmbedding: built?.withEmbedding ?? 0,
        embedModel: built?.embedModel ?? null,
        dim: built?.dim ?? p.embed.dim,
        ingestMode: p.ingest.mode,
        storeDriver: p.store?.driver || store.driver,
        readOnly: !!built?.readOnly,
        storeError,
        conceptMap: p.conceptMap.enabled,
        builtAt: built?.updatedAt ?? null,
      };
    }));
    return { store: store.driver, subjects: rows, errors };
  }

  return {
    store,
    getStore,
    getProfile,
    getEmbedder,
    getTeacher,
    defaultSubject,
    status,
    async close() {
      await store.close?.();
      for (const s of stores.values()) await s.close?.();
    },
  };
}

let _runtime = null;
/** Process-wide runtime, built on first use so .env is loaded first. */
export function getRuntime() {
  if (!_runtime) _runtime = createRuntime();
  return _runtime;
}

/** Testing seam — drops the cached runtime. */
export function resetRuntime() { _runtime = null; }
