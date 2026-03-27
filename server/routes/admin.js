import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { buildEmbeddings } from '../lib/embeddings.js';
import { getChunkCount, getMeta, getConceptMap, getKnowledgeBase } from '../lib/vectorStore.js';
import { friendlySourceName } from '../lib/claude.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

const friendlyName = friendlySourceName;

// Simple key auth — set ADMIN_KEY in .env
function auth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (process.env.ADMIN_KEY && key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(auth);

// ─── Stats overview ───────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  const conceptMap = getConceptMap();
  const meta = getMeta();

  let embeddingCount = 0;
  let sessionCount = 0;
  let chatLogCount = 0;
  let hotChunkCount = 0;

  if (supabase) {
    const [emb, sess, logs, hot] = await Promise.all([
      supabase.from('chunks').select('id', { count: 'exact', head: true }).not('embedding', 'is', null),
      supabase.from('sessions').select('id', { count: 'exact', head: true }),
      supabase.from('chat_logs').select('id', { count: 'exact', head: true }),
      supabase.from('chunk_analytics').select('id', { count: 'exact', head: true }).eq('sonnet_queued', true).eq('sonnet_done', false),
    ]);
    embeddingCount = emb.count || 0;
    sessionCount   = sess.count || 0;
    chatLogCount   = logs.count || 0;
    hotChunkCount  = hot.count || 0;
  }

  res.json({
    chunks:         getChunkCount(),
    concepts:       conceptMap?.concepts?.length || 0,
    traditions:     conceptMap?.traditions?.length || 0,
    traditionsList: conceptMap?.traditions || [],
    builtAt:        meta?.builtAt || null,
    sources:        meta?.sources || [],
    embeddings:     embeddingCount,
    sessions:       sessionCount,
    chatLogs:       chatLogCount,
    sonnetQueued:   hotChunkCount,
  });
});

// ─── Source breakdown ─────────────────────────────────────────────────────────
router.get('/sources', (req, res) => {
  const { chunks } = getKnowledgeBase();
  const map = {};
  for (const chunk of chunks) {
    if (!map[chunk.source]) map[chunk.source] = { filename: chunk.source, source: friendlyName(chunk.source), total: 0, analyzed: 0 };
    map[chunk.source].total++;
    if (chunk.meta?.summary) map[chunk.source].analyzed++;
  }
  res.json(Object.values(map).sort((a, b) => b.total - a.total));
});

// ─── Analytics ────────────────────────────────────────────────────────────────
router.get('/analytics', async (req, res) => {
  if (!supabase) return res.json({ subjects: [], hotChunks: [], recentLogs: [] });

  const [subjects, hotChunks, recentLogs] = await Promise.all([
    supabase.from('usage_summary').select('*').limit(20),
    supabase.from('hot_chunks').select('*').limit(20),
    supabase.from('chat_logs').select('user_message, subjects, sources_used, mode, created_at').order('created_at', { ascending: false }).limit(20),
  ]);

  res.json({
    subjects:   subjects.data || [],
    hotChunks:  hotChunks.data || [],
    recentLogs: recentLogs.data || [],
  });
});

// ─── Trigger embedding build ───────────────────────────────────────────────────
let embeddingRunning = false;
router.post('/build-embeddings', async (req, res) => {
  if (embeddingRunning) return res.json({ ok: false, message: 'Already running' });
  embeddingRunning = true;
  res.json({ ok: true, message: 'Embedding build started' });
  try {
    const count = await buildEmbeddings((done, total) => {
      console.log(`[embeddings] ${done}/${total}`);
    });
    console.log(`[embeddings] Done — ${count} embeddings built`);
  } catch (err) {
    console.error('[embeddings] Error:', err.message);
  } finally {
    embeddingRunning = false;
  }
});

// ─── Concept map rebuild ───────────────────────────────────────────────────────
let conceptMapRunning = false;
router.post('/build-concept-map', (req, res) => {
  if (conceptMapRunning) return res.json({ ok: false, message: 'Already running' });
  conceptMapRunning = true;
  const serverDir = path.join(__dirname, '..');
  const proc = spawn('node', ['rebuild-concepts.js'], { cwd: serverDir });
  proc.on('exit', () => { conceptMapRunning = false; });
  res.json({ ok: true, message: 'Concept map rebuild started' });
});

export default router;
