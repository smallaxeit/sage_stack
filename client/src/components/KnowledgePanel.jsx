import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../api';

/**
 * Seconds since a long operation started.
 *
 * Vision ingestion runs to minutes on a long scan, and a still screen during
 * that is indistinguishable from a dead one. A ticking number is the cheapest
 * way to say the work is still yours.
 */
function Elapsed({ since }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const s = Math.max(0, Math.round((now - since) / 1000));
  const shown = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return (
    <div style={{ color: 'var(--muted)', fontSize: 11.5, marginTop: 5 }}>
      {shown} elapsed
    </div>
  );
}

/**
 * What the knowledge base actually contains, and how to add to it.
 *
 * It keeps three states apart that are easy to conflate, because collapsing
 * them is how you end up asking questions of a base that cannot answer:
 *
 *   on disk    a file exists
 *   ingested   it was parsed into chunks
 *   embedded   those chunks are searchable
 *
 * Only the third makes a document usable, so a subject with chunks and no
 * embeddings gets a warning naming the fix rather than a green tick.
 */

const fmtBytes = (n) => {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
};

function Stat({ label, value, tone }) {
  return (
    <div style={{
      background: 'var(--panel)', border: '1px solid var(--line)',
      borderRadius: 10, padding: '10px 14px', flex: '1 1 140px',
    }}>
      <div className="label-mini">{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color: tone || 'var(--ink)', marginTop: 2 }}>{value}</div>
    </div>
  );
}

export default function KnowledgePanel({ subject, current, docs = [], onRefresh, onOpenDoc }) {
  const [expanded, setExpanded] = useState(null);
  const [chunks, setChunks] = useState({});
  const [sections, setSections] = useState([]);
  const [upload, setUpload] = useState(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);

  const readOnly = !!current?.readOnly;

  useEffect(() => {
    setExpanded(null);
    setChunks({});
    if (!subject) return;
    fetch(`/api/documents/${subject}/sections`)
      .then(r => r.json())
      .then(d => setSections(d.sections || []))
      .catch(() => setSections([]));
  }, [subject]);

  const openChunks = useCallback(async (filename) => {
    if (expanded === filename) { setExpanded(null); return; }
    setExpanded(filename);
    if (!chunks[filename]) {
      const r = await fetch(`/api/documents/${subject}/chunks/${encodeURIComponent(filename)}`)
        .then(r => r.json()).catch(() => ({ chunks: [] }));
      setChunks(c => ({ ...c, [filename]: r.chunks || [] }));
    }
  }, [expanded, chunks, subject]);

  /**
   * What the current stage is doing, in the reader's terms.
   *
   * Ingest already reports done/total per stage and an estimate before a vision
   * run; the panel used to print the bare stage name and drop the rest. On a
   * scan that meant one unchanging word for minutes, which is indistinguishable
   * from a hang.
   */
  function stageLabel(u) {
    const n = (x) => Number(x ?? 0).toLocaleString();
    const of = (done, total) => (total ? `${n(done)} of ${n(total)}` : n(done));
    switch (u.stage) {
      case 'start':         return 'Uploading';
      case 'parse':         return u.done ? `Reading page ${n(u.done)}` : 'Reading the file';
      case 'detected-scan': return `Scanned document — ${n(u.pages)} pages to read with vision`;
      case 'vision':        return `Reading page ${of(u.done, u.total)}`
                                 + (u.estimateUsd ? ` · about $${u.estimateUsd.toFixed(2)}` : '')
                                 + (u.failed ? ` · ${n(u.failed)} failed` : '');
      case 'chunk':         return 'Splitting into passages';
      case 'analyze':       return `Analyzing passage ${of(u.done, u.total)}`;
      case 'embed':         return `Embedding passage ${of(u.done, u.total)}`;
      case 'store':         return `Saving ${n(u.total)} passages`;
      default:              return u.stage;
    }
  }

  async function doUpload(file) {
    if (!file || readOnly) return;
    setUpload({ filename: file.name, stage: 'start', startedAt: Date.now() });

    const body = new FormData();
    body.append('file', file);

    try {
      // The request only hands over the file and gets a job id. The work
      // happens server-side and outlives this call, so a closed tab or a
      // dropped connection no longer takes a half-finished ingest with it.
      const res = await apiFetch(`/api/documents/${subject}/upload`, { method: 'POST', body });
      const started = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(started.error || `Upload failed (${res.status})`);

      const startedAt = Date.now();
      for (;;) {
        await new Promise(r => setTimeout(r, 1000));

        const pr = await fetch(
          `/api/documents/${subject}/upload-progress/${started.jobId}`).catch(() => null);

        if (!pr) continue;                       // a blip; the job is still running
        if (pr.status === 404) {
          const { error } = await pr.json().catch(() => ({}));
          setUpload(u => ({ ...u, stage: 'error', error: error || 'The ingest job is gone.' }));
          return;
        }

        const job = await pr.json();
        if (job.stage === 'error') { setUpload(u => ({ ...u, stage: 'error', error: job.error })); return; }
        if (job.stage === 'done') {
          setUpload({ filename: job.result.filename, stage: 'done', result: job.result });
          onRefresh?.();
          return;
        }
        setUpload(u => ({ ...u, ...job, startedAt }));
      }
    } catch (err) {
      setUpload(u => ({ ...(u || {}), stage: 'error', error: err.message }));
    }
  }

  const totalChunks = docs.reduce((n, d) => n + d.chunks, 0);
  const notSearchable = current && current.chunks > 0 && current.withEmbedding === 0;

  return (
    <div style={{ overflowY: 'auto', padding: '20px 40px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Stat label="Documents" value={docs.filter(d => d.ingested).length} />
        <Stat label="Chunks" value={totalChunks.toLocaleString()} />
        <Stat
          label="Searchable"
          value={(current?.withEmbedding ?? 0).toLocaleString()}
          tone={notSearchable ? '#d29922' : undefined}
        />
        <Stat label="Embedding model" value={current?.embedModel || '—'} />
        <Stat label="Store" value={`${current?.storeDriver || '—'}${readOnly ? ' (read-only)' : ''}`} />
      </div>

      {current?.storeError && (
        <div style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--chip)', border: '1px solid #f85149', color: '#f85149', fontSize: 13.5 }}>
          <strong>Store unreachable.</strong> {current.storeError}
        </div>
      )}

      {notSearchable && (
        <div style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--chip)', border: '1px solid #d29922', color: '#d29922', fontSize: 13.5 }}>
          <strong>Stored but not searchable.</strong> {current.chunks.toLocaleString()} chunks have no
          embeddings, so nothing here can be retrieved. Set <code>VOYAGE_API_KEY</code> in
          <code> server/.env</code>, or switch to <code>EMBED_DRIVER=local</code>, then run the
          embedding backfill.
        </div>
      )}

      {/* Upload */}
      {readOnly ? (
        <div style={{ padding: '12px 16px', borderRadius: 10, border: '1px dashed var(--line)', color: 'var(--muted)', fontSize: 13.5 }}>
          This knowledge area is <strong>read-only</strong> — it reads another database
          in place, so documents cannot be added or removed here.
        </div>
      ) : (
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); doUpload(e.dataTransfer.files?.[0]); }}
          onClick={() => fileInput.current?.click()}
          style={{
            borderRadius: 12, padding: '22px 16px', textAlign: 'center', cursor: 'pointer',
            border: `2px dashed ${dragging ? 'var(--accent)' : 'var(--line)'}`,
            background: dragging ? 'var(--chip)' : 'transparent',
          }}
        >
          <input ref={fileInput} type="file" accept=".pdf,.docx,.txt,.md,.json,.csv"
            style={{ display: 'none' }} onChange={e => doUpload(e.target.files?.[0])} />
          <div style={{ color: 'var(--ink)' }}>Drop a file here, or click to choose</div>
          <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 4 }}>
            PDF, DOCX, TXT, MD, JSON, CSV — added to {current?.name || subject}
          </div>
        </div>
      )}

      {upload && (
        <div style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--panel)', border: '1px solid var(--line)', fontSize: 13.5 }}>
          <div>
            {upload.stage === 'error' ? '✕ ' : upload.stage === 'done' ? '✓ ' : '… '}
            <strong>{upload.filename}</strong>
            {upload.stage !== 'done' && upload.stage !== 'error' && (
              <span style={{ color: 'var(--muted)' }}> — {stageLabel(upload)}</span>
            )}
          </div>

          {/* A bar only where there is something to measure. Reading a file has
              no denominator; reading page 3 of 8 does. */}
          {upload.total > 0 && upload.stage !== 'done' && upload.stage !== 'error' && (
            <div style={{ height: 3, borderRadius: 999, background: 'var(--line)', marginTop: 7, overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 999, background: 'var(--accent, #3fb950)',
                width: `${Math.min(100, Math.round(((upload.done ?? 0) / upload.total) * 100))}%`,
                transition: 'width .25s ease',
              }} />
            </div>
          )}

          {/* Vision runs to minutes on a long scan. Elapsed time is the
              difference between "slow" and "stuck". */}
          {upload.startedAt && upload.stage !== 'done' && upload.stage !== 'error' && (
            <Elapsed since={upload.startedAt} />
          )}
          {upload.error && <div style={{ color: '#f85149', fontSize: 12.5, marginTop: 4 }}>{upload.error}</div>}
          {upload.result && (
            <>
              <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 4 }}>
                {upload.result.pages} pages → {upload.result.chunks} chunks
                {upload.result.embedded > 0 && `, ${upload.result.embedded} embedded`}
                {upload.result.searchable ? ' — searchable' : ' — NOT searchable'}
              </div>
              {(upload.result.warnings || []).map((w, i) => (
                <div key={i} style={{ color: '#d29922', fontSize: 12.5, marginTop: 3 }}>⚠ {w}</div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Documents */}
      <div>
        <div className="label-mini" style={{ marginBottom: 8 }}>Documents</div>
        {docs.length === 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 13.5 }}>Nothing loaded yet.</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {docs.map(d => (
            <div key={d.filename} style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
                <button onClick={() => openChunks(d.filename)}
                  style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', color: 'var(--ink)', font: 'inherit', cursor: 'pointer' }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {expanded === d.filename ? '▾' : '▸'} {d.filename}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                    {d.ingested ? `${d.chunks.toLocaleString()} chunks` : 'not ingested'}
                    {d.pages > 0 && ` · ${d.pages.toLocaleString()} pages`}
                    {d.analyzed > 0 && ` · ${d.analyzed.toLocaleString()} analyzed`}
                    {d.bytes != null && ` · ${fmtBytes(d.bytes)}`}
                    {!d.hasFile && ' · file not stored locally'}
                  </div>
                </button>
                {/* Offer the viewer when a page can actually be shown — a
                    local PDF, or page scans served from the store. A subject
                    reading another database has the latter and not the former. */}
                {d.viewable ? (
                  <button className="btn icon" onClick={() => onOpenDoc({ filename: d.filename, title: d.filename, page: 1 })}>
                    View
                  </button>
                ) : (
                  <span style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }} title="This document's chunks were imported without their source file, and the store serves no page scans, so there is nothing to display.">
                    no preview
                  </span>
                )}
              </div>

              {expanded === d.filename && (
                <div style={{ padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 420, overflowY: 'auto' }}>
                  {(chunks[d.filename] || []).map(c => (
                    <button
                      key={c.id}
                      onClick={() => {
                        if (!d.viewable || c.pdfPage == null) return;
                        onOpenDoc({
                          filename: d.filename,
                          title: d.filename,
                          page: c.pdfPage + 1,
                          printedPage: c.printedPage,
                          excerpt: c.preview.slice(0, 220),
                        });
                      }}
                      style={{ textAlign: 'left', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 8, padding: '7px 10px', cursor: 'pointer', font: 'inherit' }}
                    >
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                        #{c.chunkIndex}
                        {c.pdfPage != null && ` · p.${c.pdfPage + 1}`}
                        {c.printedPage && ` (printed ${c.printedPage})`}
                        {c.difficulty && ` · ${c.difficulty}`}
                        {` · ${c.chars} chars`}
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--ink)', marginTop: 2 }}>
                        {c.summary || `${c.preview.slice(0, 180)}…`}
                      </div>
                      {c.concepts?.length > 0 && (
                        <div style={{ fontSize: 11.5, color: 'var(--accent)', marginTop: 4 }}>
                          {c.concepts.slice(0, 8).join(' · ')}
                        </div>
                      )}
                    </button>
                  ))}
                  {chunks[d.filename]?.length === 0 && (
                    <p style={{ color: 'var(--muted)', fontSize: 12.5 }}>No chunks stored.</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Table of contents, where the documents have one */}
      {sections.length > 0 && (
        <div>
          <div className="label-mini" style={{ marginBottom: 8 }}>Contents ({sections.length} sections)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {sections.map(s => (
              <button
                key={`${s.section}-${s.firstPage}`}
                className="chip"
                onClick={() => {
                  const doc = docs.find(d => d.viewable) || docs[0];
                  if (!doc) return;
                  onOpenDoc({ filename: doc.filename, title: s.section, page: s.firstPage + 1 });
                }}
              >
                {s.section}<span className="score">p.{s.firstPage + 1}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
