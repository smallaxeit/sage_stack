import { Router } from 'express';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import path from 'path';
import { chatStream } from '../lib/claude.js';
import { isReady, getChunkCount, getMeta, getConceptMap } from '../lib/vectorStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROGRESS_FILE = path.join(__dirname, '../build-progress.json');

const router = Router();
const sessions = new Map();

router.get('/status', (req, res) => {
  const meta = getMeta();
  const conceptMap = getConceptMap();
  res.json({
    ready: isReady(),
    chunks: getChunkCount(),
    concepts: conceptMap?.concepts?.length || 0,
    coreThemes: conceptMap?.coreThemes || [],
    builtAt: meta?.builtAt || null,
    sources: meta?.sources || [],
  });
});

let buildProcess = null;

router.post('/build', (req, res) => {
  if (buildProcess && !buildProcess.exitCode !== null) {
    return res.json({ ok: false, message: 'Build already running' });
  }
  const serverDir = path.join(__dirname, '..');
  buildProcess = spawn('node', ['build-knowledge.js'], { cwd: serverDir, detached: false });
  buildProcess.on('exit', () => { buildProcess = null; });
  res.json({ ok: true });
});

router.get('/build-progress', async (req, res) => {
  try {
    const raw = await readFile(PROGRESS_FILE, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.json({ status: 'idle' });
  }
});

router.post('/chat', async (req, res) => {
  const { message, sessionId, mode = 'deep' } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  if (!isReady()) {
    return res.status(503).json({
      error: 'Knowledge base not ready. Run "npm run build:knowledge" first.',
    });
  }

  const id = sessionId || crypto.randomUUID();
  if (!sessions.has(id)) sessions.set(id, []);

  const history = sessions.get(id);
  history.push({ role: 'user', content: message });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const { text: reply, sources, chips } = await chatStream(history, (chunk) => {
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    }, mode);

    history.push({ role: 'assistant', content: reply });
    if (history.length > 40) history.splice(0, 2);

    res.write(`data: ${JSON.stringify({ done: true, sessionId: id, sources, chips })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Claude error:', err);
    res.write(`data: ${JSON.stringify({ error: 'Failed to get response from Claude.' })}\n\n`);
    res.end();
  }
});

router.delete('/chat/:sessionId', (req, res) => {
  sessions.delete(req.params.sessionId);
  res.json({ ok: true });
});

export default router;
