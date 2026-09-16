/**
 * routes/documents.js — upload, list, serve and remove source documents.
 *
 * Serving the original file is what makes a citation useful: the UI links
 * "p.419" to the actual page of the actual PDF, so the reader can check the
 * source rather than trusting the answer. Browsers' built-in PDF viewers honor
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
// Node's built-in. Used only for randomUUID(), to give each ingest job an id a
// client can poll — the same thing routes/chat.js uses for session ids.
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';

import { getRuntime } from '../lib/runtime.js';
import { resolveStoreConfig } from '../lib/subjects.js';
import { requireAdmin } from '../lib/auth.js';
import { ingestDocument, documentsDir, pagesDir, safeFilename } from '../lib/ingest/index.js';

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
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

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
    const store = rt.getStore(profile);

    // Chunk counts per source, from the store — the authority on what the bot
    // actually knows, as opposed to what happens to be sitting on disk.
    const chunks = await store.getChunks(subject).catch(() => []);
    const bySource = new Map();
    for (const c of chunks) {
      const e = bySource.get(c.source) || { chunks: 0, analyzed: 0, pages: new Set() };
      e.chunks++;
      if (c.summary) e.analyzed++;
      if (c.pdfPage != null) e.pages.add(c.pdfPage);
      bySource.set(c.source, e);
    }

    let files = [];
    try { files = await fs.readdir(documentsDir(subject)); } catch { /* none yet */ }
    const stats = await Promise.all(files.map(async (f) => {
      const s = await fs.stat(path.join(documentsDir(subject), f));
      return { filename: f, bytes: s.size, addedAt: s.mtime.toISOString() };
    }));

    // Can this store serve page detail and rendered scans? A vision-ingested
    // corpus can, and for those the scan is a BETTER view than a PDF would be —
    // it is the exact image the model read.
    const servesPages = typeof store.getPage === 'function';

    const names = new Set([...bySource.keys(), ...stats.map(s => s.filename)]);
    const documents = [...names].map((name) => {
      const counts = bySource.get(name);
      const file = stats.find(s => s.filename === name);
      const pages = counts ? counts.pages.size : 0;
      return {
        filename: name,
        chunks: counts?.chunks ?? 0,
        analyzed: counts?.analyzed ?? 0,
        pages,
        bytes: file?.bytes ?? null,
        addedAt: file?.addedAt ?? null,
        // A document can be in the store but have no file (imported), or on
        // disk but not ingested (upload interrupted). Both are worth showing.
        hasFile: !!file,
        ingested: (counts?.chunks ?? 0) > 0,
        // Whether the UI can open a page for this document AT ALL. Gating the
        // viewer on hasFile alone was wrong: a corpus connected in place has no
        // local PDF but does have page scans, and its citations must still open.
        pageDetail: servesPages && pages > 0,
        viewable: !!file || (servesPages && pages > 0),
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
    // inline, so the browser's PDF viewer opens it and honors #page=N
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
/**
 * Ingest jobs, by id.
 *
 * Ingesting a real document takes minutes — a 48-page PDF, or a scan read page
 * by page by a vision model. This used to run inside the upload request itself
 * and stream progress back over SSE, which tied the work to the socket: close
 * the tab, restart the dev server, blink at a proxy, and the work died
 * halfway with a half-written subject and no explanation.
 *
 * So the request now does the small part — receive the file, start the job,
 * answer with its id — and the work continues here. The client polls. That is
 * how /api/build has always worked; upload was the one long operation still
 * holding its caller open.
 *
 * Kept in memory deliberately: a job is only interesting while it runs and for
 * long enough afterwards to read the result. A restart still ends the work,
 * because the process is the work — but the client finds out instead of
 * waiting forever on a socket nobody is going to write to.
 */
const jobs = new Map();
const JOB_TTL_MS = 10 * 60_000;

function newJob(subject, filename) {
  const id = crypto.randomUUID();
  jobs.set(id, {
    id, subject, filename,
    stage: 'start', startedAt: Date.now(),
    done: 0, total: 0, result: null, error: null, finishedAt: null,
  });
  return jobs.get(id);
}

/** Drop finished jobs once nobody could reasonably still be reading them. */
function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

router.post('/:subject/upload', requireAdmin, upload.single('file'), async (req, res) => {
  const { subject } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be "file")' });

  sweepJobs();

  let profile, store, embedder, analysisClient;
  try {
    const rt = getRuntime();
    profile = await rt.getProfile(subject);
    store = rt.getStore(profile);
    if (store.readOnly) {
      throw new Error(
        `Subject "${subject}" is read-only, so it cannot accept uploads. ` +
        `Create a SageStack-owned subject to ingest new documents.`,
      );
    }
    // Both enrichment stages are optional; report which are active up front so
    // the operator knows what they are getting before waiting for it.
    embedder = process.env.VOYAGE_API_KEY || profile.embed.driver === 'local'
      ? rt.getEmbedder(profile)
      : null;
    analysisClient = process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null;
  } catch (err) {
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: err.message });
  }

  const job = newJob(subject, req.file.originalname);
  res.json({
    jobId: job.id,
    filename: job.filename,
    willEmbed: !!embedder,
    willAnalyze: !!analysisClient,
  });

  // Past the response. Nothing below depends on the caller still being there.
  (async () => {
    try {
      job.result = await ingestDocument({
        profile, store, embedder, analysisClient,
        filePath: req.file.path,
        filename: req.file.originalname,
        onProgress: (p) => Object.assign(job, p),
      });
      job.stage = 'done';
    } catch (err) {
      job.stage = 'error';
      job.error = err.message;
    } finally {
      job.finishedAt = Date.now();
      await fs.unlink(req.file.path).catch(() => {});
    }
  })();
});

/** Where an ingest job has got to. The client polls this. */
router.get('/:subject/upload-progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    // Either it never existed, or the server restarted and took it with it.
    // Both mean the same thing to a client that is waiting: stop waiting.
    return res.status(404).json({
      error: 'That ingest job is gone — the server restarted, or it finished long enough ago to be cleared.',
    });
  }
  res.json(job);
});

// ─── Remove a document and its chunks ─────────────────────────────────────────
router.delete('/:subject/:filename', requireAdmin, async (req, res) => {
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

    // Only the basename of the stored path is trusted; the directory is this
    // app's own, unless the subject reads another database in place and points
    // at where that project keeps its scans.
    const cfg = resolveStoreConfig(profile) || {};
    const dir = cfg.imageDir || pagesDir(subject);
    const full = path.join(dir, path.basename(info.imagePath));
    if (path.relative(dir, full).startsWith('..')) return res.status(400).json({ error: 'Bad path' });

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
    res.json({ sections: await store.listSections(req.params.subject) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
