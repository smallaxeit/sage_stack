import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { buildEmbeddings } from '../lib/embeddings.js';
import { getMeta, getConceptMap, getSources, loadKnowledgeBase } from '../lib/vectorStore.js';
import { friendlySourceName } from '../lib/claude.js';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

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

// ─── Stats overview ───────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  const conceptMap = getConceptMap();
  const sources = getSources();

  let embeddingCount = 0;
  let totalChunks = 0;

  if (supabase) {
    const [emb, total] = await Promise.all([
      supabase.from('chunks').select('id', { count: 'exact', head: true }).not('embedding', 'is', null),
      supabase.from('chunks').select('id', { count: 'exact', head: true }),
    ]);
    embeddingCount = emb.count || 0;
    totalChunks    = total.count || 0;
  }

  res.json({
    concepts:        conceptMap?.concepts?.length || 0,
    conceptList:     (conceptMap?.concepts || []).map(c => ({ name: c.name, description: c.description, traditions: c.traditions })),
    traditions:      conceptMap?.traditions?.length || 0,
    traditionList:   (conceptMap?.traditions || []).map(t => ({ name: t.name, coreBeliefs: t.coreBeliefs })),
    coreThemes:      conceptMap?.coreThemes || [],
    sources:         sources,
    embeddings:      embeddingCount,
    totalChunks,
  });
});

// ─── Source breakdown — from knowledge-meta.json ───────────────────────────────
router.get('/sources', (req, res) => {
  const { sourceStats } = getMeta();
  if (!sourceStats || sourceStats.length === 0) return res.json([]);

  const results = sourceStats.map(s => ({
    source:   friendlySourceName(s.filename),
    filename: s.filename,
    total:    s.total,
    analyzed: s.analyzed,
  }));

  res.json(results.sort((a, b) => b.total - a.total));
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
    const count = await buildEmbeddings(({ done, total }) => {
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

// ─── Full knowledge rebuild ────────────────────────────────────────────────────
let fullBuildRunning = false;
router.post('/build', (req, res) => {
  if (fullBuildRunning) return res.json({ ok: false, message: 'Already running' });
  fullBuildRunning = true;
  const serverDir = path.join(__dirname, '..');
  const proc = spawn('node', ['build-knowledge.js'], { cwd: serverDir, env: { ...process.env } });
  proc.on('exit', () => {
    fullBuildRunning = false;
    loadKnowledgeBase().then(() => console.log('[admin] Knowledge base reloaded after build'));
  });
  res.json({ ok: true, message: 'Full knowledge rebuild started' });
});

export default router;
