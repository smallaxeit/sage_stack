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
import { loadKnowledgeBase } from './lib/vectorStore.js';
import chatRouter from './routes/chat.js';
import adminRouter from './routes/admin.js';

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', chatRouter);
app.use('/api/admin', adminRouter);

async function init() {
  console.log('Loading knowledge base...');
  const loaded = await loadKnowledgeBase();

  if (!loaded) {
    console.warn('⚠️  No knowledge base found.');
    console.warn('   Run "npm run build:knowledge" to build it from /source/');
  }

  // Serve the built React app for all non-API requests
  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/dist/index.html'));
  });

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

init();
