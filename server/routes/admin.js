import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRuntime } from '../lib/runtime.js';
import { friendlySourceName } from '../lib/subjects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

// Simple key auth — set ADMIN_KEY in .env
function auth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (process.env.ADMIN_KEY && key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(auth);

async function resolveSubject(req) {
  return req.body?.subject || req.query?.subject || await getRuntime().defaultSubject();
}

// ─── Stats overview ───────────────────────────────────────────────────────────
// Now per subject rather than global — with tenants, a single global count is
// meaningless and a cross-tenant read is exactly what §10 forbids.
router.get('/stats', async (req, res) => {
  try {
    const rt = getRuntime();
    const status = await rt.status();
    const subject = req.query.subject
      || (status.subjects.length === 1 ? status.subjects[0].slug : null);

    if (!subject) return res.json({ ...status, subject: null });

    const profile = await rt.getProfile(subject);
    const row = status.subjects.find(s => s.slug === subject) || null;

    let conceptMap = null;
    if (profile.conceptMap.enabled) {
      try { conceptMap = await rt.store.getConceptMap(subject); } catch { /* not built */ }
    }

    res.json({
      store:        status.store,
      subject,
      subjects:     status.subjects,
      errors:       status.errors,
      chunks:       row?.chunks ?? 0,
      embeddings:   row?.withEmbedding ?? 0,
      embedModel:   row?.embedModel ?? null,
      dim:          row?.dim ?? profile.embed.dim,
      concepts:     conceptMap?.concepts?.length || 0,
      traditions:   conceptMap?.traditions?.length || 0,
      traditionsList: conceptMap?.traditions || [],
      builtAt:      row?.builtAt ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Source breakdown ─────────────────────────────────────────────────────────
router.get('/sources', async (req, res) => {
  try {
    const rt = getRuntime();
    const subject = await resolveSubject(req);
    const profile = await rt.getProfile(subject);
    const chunks = await rt.store.getChunks(subject);

    const map = {};
    for (const c of chunks) {
      if (!map[c.source]) {
        map[c.source] = {
          filename: c.source,
          source: friendlySourceName(profile, c.source),
          total: 0,
          analyzed: 0,
        };
      }
      map[c.source].total++;
      if (c.summary) map[c.source].analyzed++;
    }
    res.json(Object.values(map).sort((a, b) => b.total - a.total));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Analytics ────────────────────────────────────────────────────────────────
// The Supabase analytics tables (chat_logs, chunk_analytics, usage_summary,
// hot_chunks) are not carried forward by the pivot. Reported honestly as
// unavailable rather than returning empty arrays that look like "no traffic".
router.get('/analytics', (req, res) => {
  res.status(501).json({
    error: 'Analytics were Supabase-backed and are not yet reimplemented on the new store.',
    subjects: [], hotChunks: [], recentLogs: [],
  });
});

// ─── Embedding backfill ───────────────────────────────────────────────────────
let embeddingRunning = false;
router.post('/build-embeddings', async (req, res) => {
  if (embeddingRunning) return res.json({ ok: false, message: 'Already running' });

  let rt, subject, profile, embedder;
  try {
    rt = getRuntime();
    subject = await resolveSubject(req);
    profile = await rt.getProfile(subject);
    embedder = rt.getEmbedder(profile);
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message });
  }

  embeddingRunning = true;
  res.json({ ok: true, message: `Embedding build started for ${subject}`, subject });

  try {
    const BATCH = 128;
    let done = 0;
    for (;;) {
      const missing = await rt.store.chunksMissingEmbeddings(subject, { limit: BATCH });
      if (missing.length === 0) break;
      const vectors = await embedder.embedDocuments(missing.map(m => m.text));
      await rt.store.setEmbeddings(subject, missing.map((m, i) => ({ id: m.id, vector: vectors[i] })));
      done += missing.length;
      console.log(`[embeddings:${subject}] ${done}`);
    }
    console.log(`[embeddings:${subject}] done — ${done} embedded`);
  } catch (err) {
    console.error(`[embeddings:${subject}] error:`, err.message);
  } finally {
    embeddingRunning = false;
  }
});

// ─── Concept map rebuild ──────────────────────────────────────────────────────
let conceptMapRunning = false;
router.post('/build-concept-map', async (req, res) => {
  if (conceptMapRunning) return res.json({ ok: false, message: 'Already running' });

  let subject, profile;
  try {
    subject = await resolveSubject(req);
    profile = await getRuntime().getProfile(subject);
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message });
  }
  if (!profile.conceptMap.enabled) {
    return res.json({ ok: false, message: `Subject "${subject}" has conceptMap disabled` });
  }

  conceptMapRunning = true;
  const proc = spawn('node', ['rebuild-concepts.js', '--subject', subject], {
    cwd: path.join(__dirname, '..'),
  });
  proc.on('exit', () => { conceptMapRunning = false; });
  res.json({ ok: true, message: `Concept map rebuild started for ${subject}`, subject });
});

// ─── Subjects ─────────────────────────────────────────────────────────────────
router.get('/subjects', async (req, res) => {
  try {
    res.json(await getRuntime().status());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
