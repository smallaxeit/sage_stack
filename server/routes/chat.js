import { Router } from 'express';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import { getRuntime } from '../lib/runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROGRESS_FILE = path.join(__dirname, '../build-progress.json');

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

let buildProcess = null;

router.post('/build', async (req, res) => {
  if (buildProcess && buildProcess.exitCode === null) {
    return res.json({ ok: false, message: 'Build already running' });
  }
  let subject;
  try { subject = await resolveSubject(req); }
  catch (err) { return res.status(400).json({ ok: false, message: err.message }); }

  buildProcess = spawn('node', ['build-knowledge.js', '--subject', subject], {
    cwd: path.join(__dirname, '..'),
    detached: false,
  });
  buildProcess.on('exit', () => { buildProcess = null; });
  res.json({ ok: true, subject });
});

router.get('/build-progress', async (req, res) => {
  try {
    res.json(JSON.parse(await readFile(PROGRESS_FILE, 'utf-8')));
  } catch {
    res.json({ status: 'idle' });
  }
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
