import { Router } from 'express';
import { readdir } from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { getRuntime } from '../lib/runtime.js';
import { subjectSourceDir } from '../lib/subjects.js';
import { ingestDirectory } from '../lib/ingest/index.js';
import { requireAdmin } from '../lib/auth.js';
import { availableTerms } from '../lib/prefer.js';

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

router.post('/build', requireAdmin, async (req, res) => {
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

    building.results = await ingestDirectory({
      dir, profile, store, embedder, analysisClient,
      onDocument: ({ filename, index, result, error }) => {
        building.current = filename;
        // Only advance on completion; the start event carries no result.
        if (result || error) building.done = index + 1;
      },
      onProgress: (p) => {
        building.stage = p.stage;
        building.stageDone = p.done;
        building.stageTotal = p.total;
      },
    });

    building.finishedAt = Date.now();
    setTimeout(() => { building = null; }, 60_000);  // keep the result briefly
  })().catch((err) => {
    // Never leave the flag set — a stuck flag blocks every future build.
    console.error('[build] failed:', err);
    building = { ...building, finishedAt: Date.now(), error: err.message };
    setTimeout(() => { building = null; }, 60_000);
  });
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
  // Proxies buffer by default, which defeats streaming entirely.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Retrieval plus a cold model call can be 5-30 seconds before the first
  // token. A silent socket for that long is indistinguishable from a hang, and
  // a dev proxy will report it as ECONNRESET. So say something immediately,
  // then keep the connection warm until real tokens arrive.
  const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  send({ stage: 'retrieving' });

  const keepalive = setInterval(() => {
    // An SSE comment: keeps intermediaries from timing the socket out, and is
    // ignored by EventSource and by our own parser alike.
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, 10_000);

  // If the user navigates away or hits Stop, don't keep generating.
  let aborted = false;
  req.on('close', () => { aborted = true; clearInterval(keepalive); });

  try {
    const { text: reply, sources, chips } = await teacher.chatStream(
      history,
      chunk => send({ chunk }),
      { mode, onStage: (stage) => send({ stage }) },
    );

    if (aborted) return;   // client is gone; nothing to save or send

    history.push({ role: 'assistant', content: reply });
    if (history.length > 40) history.splice(0, 2);
    await rt.store.saveSession(key, history);

    send({ done: true, sessionId: id, subject, sources, chips });
    res.end();
  } catch (err) {
    console.error(`[${subject}] chat error:`, err);
    // The real reason matters for an operator-run tool — an unbuilt subject or
    // an embedder mismatch is actionable. But the raw SDK message is often a
    // JSON blob, which is unreadable in a chat bubble, so translate the ones
    // that have a clear cause and a clear fix.
    send({ error: explainChatError(err) });
    res.end();
  } finally {
    clearInterval(keepalive);
  }
});

/**
 * Turn an SDK/API failure into something an operator can act on.
 *
 * These are the failures that actually stop the app, and each has exactly one
 * fix. Anything unrecognised falls through with its own message rather than
 * being flattened into "something went wrong".
 */
export function explainChatError(err) {
  const raw = String(err?.message ?? err ?? '');
  const status = err?.status ?? err?.statusCode;

  // The SDK puts the API's JSON body in the message; pull the human part out.
  let detail = raw;
  const brace = raw.indexOf('{');
  if (brace !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(brace));
      detail = parsed?.error?.message || parsed?.message || raw;
    } catch { /* not JSON after all */ }
  }

  if (/credit balance is too low/i.test(detail)) {
    return 'Anthropic account is out of credits — answers cannot be generated. '
         + 'Add credits at console.anthropic.com (Plans & Billing). '
         + 'Nothing is wrong with the knowledge base; it is untouched.';
  }
  if (status === 401 || /invalid x-api-key|authentication/i.test(detail)) {
    return 'ANTHROPIC_API_KEY is missing or rejected. Check it in server/.env, then restart the server.';
  }
  if (status === 429 || /rate.?limit/i.test(detail)) {
    return 'Rate limited by the API. Wait a moment and ask again.';
  }
  if (/VOYAGE_API_KEY/i.test(detail)) {
    return 'VOYAGE_API_KEY is not set, so the question cannot be embedded and nothing can be retrieved. '
         + 'Add it to server/.env, or set EMBED_DRIVER=local.';
  }
  if (/voyage api error/i.test(detail)) {
    return `The embedding service rejected the request — ${detail}`;
  }
  if (/model mismatch|dimension mismatch/i.test(detail)) {
    return detail;   // already written for a human
  }
  if (/no built knowledge base/i.test(detail)) {
    return detail;
  }
  if (status >= 500) {
    return 'The model API returned a server error. This is usually transient — try again.';
  }
  return detail;
}

// ─── Subject settings ─────────────────────────────────────────────────────────
// Small state belonging to a knowledge area rather than a conversation. For Rx
// this is the reader's current medication list, which has to survive starting a
// new chat and restarting the server.

router.get('/settings', async (req, res) => {
  try {
    const rt = getRuntime();
    const subject = await resolveSubject(req);
    const profile = await rt.getProfile(subject);
    const store = rt.getStore(profile);

    const settings = store.getSettings ? await store.getSettings(subject) : {};
    const key = profile.retrieval.filterKey;

    // What could be selected, drawn from what the documents actually contain —
    // offering something with nothing behind it produces an empty answer.
    let available = [];
    if (key) {
      try {
        // A projection, not every chunk — see listExtraValues.
        const values = store.listExtraValues
          ? await store.listExtraValues(subject, key)
          : await store.getChunks(subject);
        available = availableTerms(values, key);
      } catch { /* nothing loaded yet */ }
    }

    res.json({
      subject,
      filterKey: key,
      // A label the UI can show without knowing what the subject is about.
      filterLabel: key ? key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : null,
      active: key ? (settings[key] ?? []) : [],
      available,
      settings,
      readOnly: !!store.readOnly,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const rt = getRuntime();
    const subject = await resolveSubject(req);
    const profile = await rt.getProfile(subject);
    const store = rt.getStore(profile);

    if (!store.saveSettings || store.readOnly) {
      return res.status(409).json({
        error: `Subject "${subject}" is backed by a read-only store, so its settings cannot be saved.`,
      });
    }

    // Settings need a row to live in, and a reader may set their list before
    // loading anything. Registering an empty subject is idempotent and cheap.
    await store.initSubject(subject, {
      dim: profile.embed.dim,
      embedModel: profile.embed.model,
      name: profile.name,
    });

    const key = profile.retrieval.filterKey;
    const current = await store.getSettings(subject);

    // Only the configured list is writable from here. An open settings blob
    // would be a way to put arbitrary text into the prompt.
    if (key && Array.isArray(req.body?.active)) {
      const cleaned = [...new Set(
        req.body.active
          .filter(x => typeof x === 'string')
          .map(x => x.trim().toLowerCase())
          .filter(Boolean),
      )].slice(0, 100);
      current[key] = cleaned;
    }

    await store.saveSettings(subject, current);
    res.json({ subject, filterKey: key, active: key ? (current[key] ?? []) : [] });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Conversation history ─────────────────────────────────────────────────────
// Sessions were already persisted per subject on every turn; they were just
// never listable. Reloading one costs nothing — the messages are stored, so
// re-opening a conversation makes no API call.

router.get('/sessions', async (req, res) => {
  try {
    const rt = getRuntime();
    const subject = await resolveSubject(req);
    const sessions = rt.store.listSessions ? await rt.store.listSessions(subject) : [];
    res.json({ subject, sessions });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/sessions/:sessionId', async (req, res) => {
  try {
    const rt = getRuntime();
    const subject = await resolveSubject(req);
    const messages = await rt.store.getSession(sessionKey(subject, req.params.sessionId));
    if (!messages) return res.status(404).json({ error: 'No such conversation' });
    res.json({ subject, sessionId: req.params.sessionId, messages });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const subject = await resolveSubject(req);
    const ok = await getRuntime().store.deleteSession(sessionKey(subject, req.params.sessionId));
    res.json({ ok });
  } catch (err) {
    res.status(400).json({ error: err.message });
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
