import { Router } from 'express';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import path from 'path';
import { chatStream } from '../lib/claude.js';
import { isReady, getChunkCount, getMeta, getConceptMap } from '../lib/vectorStore.js';
import supabase from '../lib/supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROGRESS_FILE = path.join(__dirname, '../build-progress.json');

const router = Router();

// Session helpers — Supabase-backed, falls back to in-memory if Supabase unavailable
const memSessions = new Map();

async function getSession(id) {
  if (supabase) {
    const { data } = await supabase.from('sessions').select('messages').eq('id', id).single();
    return data?.messages || [];
  }
  return memSessions.get(id) || [];
}

async function saveSession(id, messages) {
  if (supabase) {
    await supabase.from('sessions').upsert({ id, messages }, { onConflict: 'id' });
  } else {
    memSessions.set(id, messages);
  }
}

async function deleteSession(id) {
  if (supabase) {
    await supabase.from('sessions').delete().eq('id', id);
  } else {
    memSessions.delete(id);
  }
}

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
  const history = await getSession(id);
  history.push({ role: 'user', content: message });

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const { text: reply, sources, chips, analytics, outputTokens } = await chatStream(history, (chunk) => {
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    }, mode);

    history.push({ role: 'assistant', content: reply });
    if (history.length > 40) history.splice(0, 2);
    await saveSession(id, history);

    // Fire-and-forget analytics logging
    if (supabase) {
      Promise.all([
        // Log the chat interaction
        supabase.from('chat_logs').insert({
          session_id: id,
          user_message: message,
          assistant_response: reply,
          mode,
          subjects: analytics?.subjects || [],
          themes: analytics?.themes || [],
          sources_used: (sources || []).map(s => s.source),
          chunks_used: analytics?.chunkRefs || [],
          response_tokens: outputTokens || null,
        }),

        // Upsert chunk analytics — increment query_count for each retrieved chunk
        ...(analytics?.chunkRefs || []).map(ref =>
          supabase.rpc('increment_chunk_query', { p_source: ref.source, p_chunk_index: ref.chunk_index })
            .then(({ error }) => {
              // If RPC doesn't exist yet, fall back to upsert
              if (error) {
                return supabase.from('chunk_analytics').upsert({
                  source: ref.source,
                  chunk_index: ref.chunk_index,
                  query_count: 1,
                  last_queried_at: new Date().toISOString(),
                }, { onConflict: 'source,chunk_index', ignoreDuplicates: false });
              }
            })
        ),
      ]).catch(err => console.warn('[analytics] Log error:', err.message));
    }

    res.write(`data: ${JSON.stringify({ done: true, sessionId: id, sources, chips })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Claude error:', err);
    res.write(`data: ${JSON.stringify({ error: 'Failed to get response from Claude.' })}\n\n`);
    res.end();
  }
});

router.delete('/chat/:sessionId', async (req, res) => {
  await deleteSession(req.params.sessionId);
  res.json({ ok: true });
});

export default router;
