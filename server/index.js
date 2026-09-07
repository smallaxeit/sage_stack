import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const lines = readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n');
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq === -1 || line.trim().startsWith('#')) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
} catch {}

import express from 'express';
import cors from 'cors';
import { getRuntime } from './lib/runtime.js';
import { isOpen } from './lib/auth.js';
import { checkModelPricing } from './lib/models.js';
import chatRouter from './routes/chat.js';
import adminRouter from './routes/admin.js';
import documentsRouter from './routes/documents.js';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', chatRouter);
app.use('/api/admin', adminRouter);
app.use('/api/documents', documentsRouter);

/**
 * Report what is available at boot, but never block on it. Subjects load
 * lazily, so a missing knowledge base, an unreachable database, or an absent
 * API key must not stop the server from starting — the operator needs the
 * admin panel up precisely when something is unbuilt.
 */
async function reportSubjects() {
  try {
    const { store, subjects, errors } = await getRuntime().status();
    console.log(`Store: ${store}`);

    if (subjects.length === 0) {
      console.warn('No subjects defined. Add subjects/<slug>/subject.json');
    }
    for (const s of subjects) {
      const state = s.ready
        ? `${s.chunks} chunks, ${s.withEmbedding} embedded (${s.embedModel ?? 'model unknown'}, ${s.dim}d)`
        : s.chunks > 0
          ? `${s.chunks} chunks, NOT EMBEDDED — run the embedding backfill`
          : 'not built — add documents in the Knowledge screen, or POST /api/build';
      console.log(`  ${s.ready ? 'ok  ' : '--  '} ${s.slug.padEnd(12)} ${state}`);
    }
    for (const e of errors) {
      console.warn(`  !!   ${e.slug}: ${e.error}`);
    }
  } catch (err) {
    console.warn(`Could not read subject status: ${err.message}`);
  }
}

async function init() {
  await reportSubjects();

  // Serve the built React app for all non-API requests
  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    // A model with no price on file still works; it just cannot be costed,
    // and an answer showing no cost is easier to explain at boot than later.
    checkModelPricing(console);
    if (isOpen()) {
      console.warn(
        '  ADMIN_KEY is not set: upload, build and delete are unauthenticated. ' +
        'Fine locally; set it before exposing this server.',
      );
    }
  });
}

init();
