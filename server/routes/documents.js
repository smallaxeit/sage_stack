/**
 * routes/documents.js — upload, list, serve and remove source documents.
 *
 * Serving the original file is what makes a citation useful: the UI links
 * "p.419" to the actual page of the actual PDF, so the reader can check the
 * source rather than trusting the answer. Browsers' built-in PDF viewers honour
 * a #page=N fragment, so no client-side PDF library is needed.
 *
 * Every route is scoped to one subject. Paths are built from a validated slug
 * plus a basename-only filename, so nothing can escape the subject's directory.
 */

import { Router } from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import os from 'os';
import Anthropic from '@anthropic-ai/sdk';

import { getRuntime } from '../lib/runtime.js';
import { resolveStoreConfig } from '../lib/subjects.js';
import { ingestDocument, documentsDir, safeFilename } from '../lib/ingest/index.js';

const router = Router();

const upload = multer({
  dest: path.join(os.tmpdir(), 'sagestack-uploads'),
  limits: { fileSize: 512 * 1024 * 1024 },
});

const CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md':  'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (process.env.ADMIN_KEY && key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/** Resolve a file inside the subject's document directory, or null. */
async function resolveDoc(slug, filename) {
  const dir = documentsDir(slug);
  const full = path.join(dir, safeFilename(filename));
  if (path.relative(dir, full).startsWith('..')) return null;
  try { await fs.access(full); return full; } catch { return null; }
}

// ─── List documents for a subject ─────────────────────────────────────────────
router.get('/:subject', async (req, res) => {
  try {
    const rt = getRuntime();
    const { subject } = req.params;
    const profile = await rt.getProfile(subject);

    // Chunk counts per source, from the store — the authority on what the bot
    // actually knows, as opposed to what happens to be sitting on disk.
    const chunks = await rt.getStore(profile).getChunks(subject).catch(() => []);
    const bySource = new Map();
    for (const c of chunks) {
      const e = bySource.get(c.source) || { chunks: 0, analysed: 0, pages: new Set() };
      e.chunks++;
      if (c.summary) e.analysed++;
      if (c.pdfPage != null) e.pages.add(c.pdfPage);
      bySource.set(c.source, e);
    }

    let files = [];
    try { files = await fs.readdir(documentsDir(subject)); } catch { /* none yet */ }
    const stats = await Promise.all(files.map(async (f) => {
      const s = await fs.stat(path.join(documentsDir(subject), f));
      return { filename: f, bytes: s.size, addedAt: s.mtime.toISOString() };
    }));

    const names = new Set([...bySource.keys(), ...stats.map(s => s.filename)]);
    const documents = [...names].map((name) => {
      const counts = bySource.get(name);
      const file = stats.find(s => s.filename === name);
      return {
        filename: name,
        chunks: counts?.chunks ?? 0,
        analysed: counts?.analysed ?? 0,
        pages: counts ? counts.pages.size : 0,
        bytes: file?.bytes ?? null,
        addedAt: file?.addedAt ?? null,
        // A document can be in the store but have no file (imported), or on
        // disk but not ingested (upload interrupted). Both are worth showing.
        hasFile: !!file,
        ingested: (counts?.chunks ?? 0) > 0,
      };
    }).sort((a, b) => b.chunks - a.chunks || a.filename.localeCompare(b.filename));

    res.json({ subject, documents });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Serve a document (the page viewer reads this) ────────────────────────────
router.get('/:subject/file/:filename', async (req, res) => {
  try {
    const full = await resolveDoc(req.params.subject, req.params.filename);
    if (!full) return res.status(404).json({ error: 'Document not found' });

    const ext = path.extname(full).toLowerCase();
    res.setHeader('Content-Type', CONTENT_TYPES[ext] || 'application/octet-stream');
    // inline, so the browser's PDF viewer opens it and honours #page=N
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(full))}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    createReadStream(full).pipe(res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── The chunks of one document, for the knowledge browser ────────────────────
router.get('/:subject/chunks/:filename', async (req, res) => {
  try {
    const rt = getRuntime();
    const { subject, filename } = req.params;
    const profile = await rt.getProfile(subject);
    const all = await rt.getStore(profile).getChunks(subject);
    const mine = all
      .filter(c => c.source === filename)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map(c => ({
        id: c.id,
        chunkIndex: c.chunkIndex,
        pdfPage: c.pdfPage,
        printedPage: c.printedPage,
        summary: c.summary,
        concepts: c.concepts,
        themes: c.themes,
        difficulty: c.difficulty,
        preview: c.text.slice(0, 400),
        chars: c.text.length,
      }));
    res.json({ subject, filename, chunks: mine });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Upload + ingest ──────────────────────────────────────────────────────────
// Progress is streamed as SSE, because a large PDF takes long enough that a
// silent spinner is indistinguishable from a hang.
router.post('/:subject/upload', adminAuth, upload.single('file'), async (req, res) => {
  const { subject } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const rt = getRuntime();
    const profile = await rt.getProfile(subject);
    const store = rt.getStore(profile);
    if (store.readOnly) {
      throw new Error(
        `Subject "${subject}" connects to an existing read-only corpus, so it cannot accept uploads. ` +
        `Create a SageStack-owned subject to ingest new documents.`,
      );
    }

    // Both enrichment stages are optional; report which are active up front so
    // the operator knows what they are getting before waiting for it.
    const embedder = process.env.VOYAGE_API_KEY || profile.embed.driver === 'local'
      ? rt.getEmbedder(profile)
      : null;
    const analysisClient = process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null;

    send({ stage: 'start', filename: req.file.originalname, willEmbed: !!embedder, willAnalyse: !!analysisClient });

    const result = await ingestDocument({
      profile,
      store,
      embedder,
      analysisClient,
      filePath: req.file.path,
      filename: req.file.originalname,
      onProgress: send,
    });

    send({ stage: 'done', result });
  } catch (err) {
    send({ stage: 'error', error: err.message });
  } finally {
    await fs.unlink(req.file.path).catch(() => {});
    res.end();
  }
});

// ─── Remove a document and its chunks ─────────────────────────────────────────
router.delete('/:subject/:filename', adminAuth, async (req, res) => {
  try {
    const rt = getRuntime();
    const { subject } = req.params;
    const filename = safeFilename(req.params.filename);
    const profile = await rt.getProfile(subject);
    const store = rt.getStore(profile);
    if (store.readOnly) {
      return res.status(409).json({
        error: `Subject "${subject}" is backed by a read-only store — nothing can be deleted through SageStack.`,
      });
    }

    const all = await store.getChunks(subject);
    const mine = all.filter(c => c.source === filename);
    if (store.deleteChunks) await store.deleteChunks(subject, mine.map(c => c.id));

    const full = await resolveDoc(subject, filename);
    if (full) await fs.unlink(full);

    res.json({ ok: true, filename, removedChunks: mine.length, fileRemoved: !!full });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Scanned page image ───────────────────────────────────────────────────────
// A vision-ingested corpus keeps a rendered PNG per page (ask_cooter does this),
// which beats a PDF viewer for a scan: it is the exact image the model read.
router.get('/:subject/page-image/:page', async (req, res) => {
  try {
    const rt = getRuntime();
    const { subject } = req.params;
    const profile = await rt.getProfile(subject);
    const store = rt.getStore(profile);

    if (!store.getPage) return res.status(404).json({ error: 'This subject has no page images' });

    const page = Number(req.params.page);
    if (!Number.isInteger(page) || page < 0) return res.status(400).json({ error: 'Bad page number' });

    const info = await store.getPage(subject, page);
    if (!info?.imagePath) return res.status(404).json({ error: 'No image for that page' });

    // The stored path is relative to the other project's root, so only its
    // basename is trusted; the directory comes from this app's configuration.
    const cfg = resolveStoreConfig(profile) || {};
    if (!cfg.imageDir) return res.status(404).json({ error: 'No image directory configured for this subject' });
    const full = path.join(cfg.imageDir, path.basename(info.imagePath));
    if (path.relative(cfg.imageDir, full).startsWith('..')) return res.status(400).json({ error: 'Bad path' });

    try { await fs.access(full); } catch { return res.status(404).json({ error: 'Image file missing on disk' }); }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    createReadStream(full).pipe(res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Page detail (text, specs, diagrams) ──────────────────────────────────────
router.get('/:subject/page/:page', async (req, res) => {
  try {
    const rt = getRuntime();
    const profile = await rt.getProfile(req.params.subject);
    const store = rt.getStore(profile);
    if (!store.getPage) return res.status(404).json({ error: 'This subject has no page detail' });

    const info = await store.getPage(req.params.subject, Number(req.params.page));
    if (!info) return res.status(404).json({ error: 'No such page' });
    const { imagePath, ...rest } = info;
    res.json({ ...rest, hasImage: !!imagePath });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Section table of contents ────────────────────────────────────────────────
router.get('/:subject/sections', async (req, res) => {
  try {
    const rt = getRuntime();
    const profile = await rt.getProfile(req.params.subject);
    const store = rt.getStore(profile);
    if (!store.listSections) return res.json({ sections: [] });
    res.json({ sections: await store.listSections() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
