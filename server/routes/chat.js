import { Router } from 'express';
import { readdir } from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { getRuntime } from '../lib/runtime.js';
import { subjectSourceDir } from '../lib/subjects.js';
import { ingestDocument } from '../lib/ingest/index.js';

const router = Router();

/**
 * Resolve the subject for a request. Requests may name one; otherwise the
 * runtime picks a default. Sessions are keyed per subject so a conversation
 * can never carry context across tenants (§10).
 */
async function resolveSubject(req) {
  const rt = getRuntime();
  const named = req.body?.subject || req.query?.subject || req.params?.subject;
  return named || await rt.defaultSubject();
}

const sessionKey = (subject, id) => `${subject}::${id}`;

// ─── Status ───────────────────────────────────────────────────────────────────

router.get('/status', async (req, res) => {
  try {
    const rt = getRuntime();
    const status = await rt.status();
    const subject = req.query.subject || (status.subjects.length === 1 ? status.subjects[0].slug : null);
    const row = status.subjects.find(s => s.slug === subject) || null;

    let conceptMap = null;
    if (row?.conceptMap) {
      try {
        const profile = await rt.getProfile(row.slug);
        conceptMap = await rt.getStore(profile).getConceptMap(row.slug);
      } catch { /* not built */ }
    }

    res.json({
      store: status.store,
      subjects: status.subjects,
      errors: status.errors,
      // Fields the existing client reads, scoped to the resolved subject.
      ready: row?.ready ?? false,
      chunks: row?.chunks ?? 0,
      concepts: conceptMap?.concepts?.length || 0,
      coreThemes: conceptMap?.coreThemes || [],
      builtAt: row?.builtAt ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Build ────────────────────────────────────────────────────────────────────
// Bulk-ingests every file in the subject's source directory. Previously this
// spawned build-knowledge.js, which ignored --subject and wrote to Supabase;
// it now runs the same pipeline the upload route uses, in-process, so progress
// is real rather than polled from a file another process may never write.

let building = null;   // { subject, startedAt, done, total, current, results }

router.post('/build', async (req, res) => {
  if (building) return res.json({ ok: false, message: `Build already running for ${building.subject}` });

  let subject, profile, store;
  try {
    const rt = getRuntime();
    subject = await resolveSubject(req);
    profile = await rt.getProfile(subject);
    store = rt.getStore(profile);
    if (store.readOnly) {
      return res.status(409).json({ ok: false, message: `Subject "${subject}" is read-only.` });
    }
  } catch (err) {
    return res.status(400).json({ ok: false, message: err.message });
  }

  const dir = subjectSourceDir(subject);
  let files;
  try {
    files = (await readdir(dir)).filter(f => !f.startsWith('.'));
  } catch {
    return res.status(400).json({ ok: false, message: `No source directory for "${subject}" (expected ${dir})` });
  }
  if (files.length === 0) {
    return res.status(400).json({ ok: false, message: `No files in ${dir}` });
  }

  building = { subject, startedAt: Date.now(), done: 0, total: files.length, current: null, results: [] };
  res.json({ ok: true, subject, files: files.length });

  // Runs past the response; /build-progress reports it.
  (async () => {
    const rt = getRuntime();
    const embedder = process.env.VOYAGE_API_KEY || profile.embed.driver === 'local'
      ? rt.getEmbedder(profile) : null;
    const analysisClient = process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

    for (const file of files) {
      building.current = file;
      try {
        const result = await ingestDocument({
          profile, store, embedder, analysisClient,
          filePath: path.join(dir, file),
          filename: file,
          onProgress: (p) => { building.stage = p.stage; building.stageDone = p.done; building.stageTotal = p.total; },
        });
        building.results.push(result);
      } catch (err) {
        building.results.push({ filename: file, error: err.message });
      }
      building.done++;
    }
    building.finishedAt = Date.now();
    setTimeout(() => { building = null; }, 60_000);  // keep the result briefly
  })().catch(() => { building = null; });
});

router.get('/build-progress', (req, res) => {
  if (!building) return res.json({ status: 'idle' });
  res.json({
    status: building.finishedAt ? 'done' : 'running',
    subject: building.subject,
    current: building.done,
    total: building.total,
    file: building.current,
    stage: building.stage ?? null,
    stageDone: building.stageDone ?? null,
    stageTotal: building.stageTotal ?? null,
    pct: building.total ? Math.round((building.done / building.total) * 100) : 0,
    results: building.finishedAt ? building.results : undefined,
  });
});

// ─── Chat ─────────────────────────────────────────────────────────────────────

router.post('/chat', async (req, res) => {
  const { message, sessionId, mode = 'deep' } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  const rt = getRuntime();
  let subject, teacher;
  try {
    subject = await resolveSubject(req);
    teacher = await rt.getTeacher(subject);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const id = sessionId || crypto.randomUUID();
  const key = sessionKey(subject, id);
  const history = (await rt.store.getSession(key)) || [];
  history.push({ role: 'user', content: message });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const { text: reply, sources, chips } = await teacher.chatStream(
      history,
      chunk => res.write(`data: ${JSON.stringify({ chunk })}\n\n`),
      { mode },
    );

    history.push({ role: 'assistant', content: reply });
    if (history.length > 40) history.splice(0, 2);
    await rt.store.saveSession(key, history);

    res.write(`data: ${JSON.stringify({ done: true, sessionId: id, subject, sources, chips })}\n\n`);
    res.end();
  } catch (err) {
    console.error(`[${subject}] chat error:`, err);
    // The real reason matters for an operator-run tool — an unbuilt subject or
    // an embedder mismatch is actionable, and hiding it behind flavour text
    // costs more than the flavour is worth.
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

router.delete('/chat/:sessionId', async (req, res) => {
  try {
    const subject = await resolveSubject(req);
    await getRuntime().store.deleteSession(sessionKey(subject, req.params.sessionId));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
