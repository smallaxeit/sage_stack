import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * KnowledgePanel — what the bot actually knows, and how to add to it.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It does not report "ready" from the presence of a file. A document can be
 *    on disk but not ingested, or ingested but not embedded (and therefore not
 *    searchable at all). Those states are shown separately, because conflating
 *    them is how you end up asking questions of an empty knowledge base.
 *  - It does not hide ingestion warnings. If analysis or embedding was skipped
 *    for want of an API key, that is the single most useful thing on screen.
 */

const fmtBytes = (n) => {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
};

function Stat({ label, value, tone }) {
  return (
    <div className="rounded-lg px-3 py-2 flex-1 min-w-24"
      style={{ background: 'var(--source-bg)', border: '1px solid var(--source-border)' }}>
      <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{label}</p>
      <p className="text-lg font-semibold" style={{ color: tone || 'var(--text-primary)' }}>{value}</p>
    </div>
  );
}

export default function KnowledgePanel({ subject, subjects, onSubjectChange, onOpenDoc, adminKey }) {
  const [docs, setDocs] = useState([]);
  const [stats, setStats] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [chunks, setChunks] = useState({});
  const [upload, setUpload] = useState(null);   // { filename, stage, done, total, warnings, error }
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(null);
  const fileInput = useRef(null);

  const load = useCallback(async () => {
    if (!subject) return;
    setError(null);
    try {
      const [d, s] = await Promise.all([
        fetch(`/api/documents/${subject}`).then(r => r.json()),
        fetch(`/api/admin/stats?subject=${subject}`, { headers: adminKey ? { 'x-admin-key': adminKey } : {} })
          .then(r => r.json()).catch(() => null),
      ]);
      if (d.error) throw new Error(d.error);
      setDocs(d.documents || []);
      setStats(s && !s.error ? s : null);
    } catch (err) {
      setError(err.message);
    }
  }, [subject, adminKey]);

  useEffect(() => { load(); }, [load]);

  async function openChunks(filename) {
    if (expanded === filename) { setExpanded(null); return; }
    setExpanded(filename);
    if (!chunks[filename]) {
      const r = await fetch(`/api/documents/${subject}/chunks/${encodeURIComponent(filename)}`).then(r => r.json());
      setChunks(c => ({ ...c, [filename]: r.chunks || [] }));
    }
  }

  /** Upload streams SSE progress — a large PDF is slow enough that a silent
   *  spinner is indistinguishable from a hang. */
  async function doUpload(file) {
    if (!file) return;
    setUpload({ filename: file.name, stage: 'start' });

    const body = new FormData();
    body.append('file', file);

    try {
      const res = await fetch(`/api/documents/${subject}/upload`, {
        method: 'POST',
        headers: adminKey ? { 'x-admin-key': adminKey } : {},
        body,
      });
      if (!res.ok && res.headers.get('content-type')?.includes('json')) {
        throw new Error((await res.json()).error || `Upload failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.stage === 'error') { setUpload(u => ({ ...u, stage: 'error', error: ev.error })); return; }
          if (ev.stage === 'done') {
            setUpload({ filename: ev.result.filename, stage: 'done', result: ev.result });
            load();
            return;
          }
          setUpload(u => ({ ...u, ...ev }));
        }
      }
    } catch (err) {
      setUpload(u => ({ ...(u || {}), stage: 'error', error: err.message }));
    }
  }

  const current = subjects?.find(s => s.slug === subject);
  const totalChunks = docs.reduce((n, d) => n + d.chunks, 0);
  const notSearchable = stats && stats.chunks > 0 && stats.embeddings === 0;

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto p-4">

      {/* Subject switcher — subjects are tenants, so this is a hard boundary */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Knowledge area</span>
        {(subjects || []).map(s => (
          <button
            key={s.slug}
            onClick={() => onSubjectChange(s.slug)}
            className="text-xs px-3 py-1.5 rounded-full transition-colors"
            style={{
              background: s.slug === subject ? 'var(--chip-text)' : 'var(--chip-bg)',
              color: s.slug === subject ? 'var(--surface)' : 'var(--chip-text)',
              border: '1px solid var(--chip-border)',
            }}
          >
            {s.name}{!s.ready && ' ·'}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg px-3 py-2 text-sm"
          style={{ background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.4)', color: '#dc2626' }}>
          {error}
        </div>
      )}

      {/* What the bot knows */}
      <div className="flex gap-2 flex-wrap">
        <Stat label="Documents" value={docs.filter(d => d.ingested).length} />
        <Stat label="Chunks" value={totalChunks} />
        <Stat
          label="Searchable"
          value={stats ? `${stats.embeddings}` : '—'}
          tone={notSearchable ? '#dc2626' : undefined}
        />
        <Stat label="Embedding" value={stats?.embedModel || current?.embedModel || '—'} />
      </div>

      {notSearchable && (
        <div className="rounded-lg px-3 py-2 text-sm"
          style={{ background: 'rgba(217,119,6,0.1)', border: '1px solid rgba(217,119,6,0.4)', color: '#b45309' }}>
          <strong>Stored but not searchable.</strong> {stats.chunks} chunks have no embeddings, so the
          chatbot cannot retrieve any of them. Set <code>VOYAGE_API_KEY</code>, or
          use <code>EMBED_DRIVER=local</code>, then run the embedding backfill.
        </div>
      )}

      {/* Upload */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); doUpload(e.dataTransfer.files?.[0]); }}
        onClick={() => fileInput.current?.click()}
        className="rounded-xl px-4 py-6 text-center cursor-pointer transition-colors"
        style={{
          border: `2px dashed ${dragging ? 'var(--chip-text)' : 'var(--border)'}`,
          background: dragging ? 'var(--chip-bg)' : 'transparent',
        }}
      >
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.txt,.md,.json,.csv"
          className="hidden"
          onChange={e => doUpload(e.target.files?.[0])}
        />
        <p className="text-sm" style={{ color: 'var(--text-primary)' }}>
          Drop a PDF here, or click to choose
        </p>
        <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
          PDF, TXT, MD, JSON, CSV — added to <strong>{current?.name || subject}</strong>
        </p>
      </div>

      {upload && (
        <div className="rounded-lg px-3 py-2 text-sm"
          style={{ background: 'var(--source-bg)', border: '1px solid var(--source-border)' }}>
          <p style={{ color: 'var(--text-primary)' }}>
            {upload.stage === 'error' ? '✕ ' : upload.stage === 'done' ? '✓ ' : '… '}
            <strong>{upload.filename}</strong>
            {upload.stage !== 'done' && upload.stage !== 'error' && ` — ${upload.stage}`}
            {upload.total ? ` ${upload.done ?? 0}/${upload.total}` : ''}
          </p>
          {upload.error && <p className="text-xs mt-1" style={{ color: '#dc2626' }}>{upload.error}</p>}
          {upload.result && (
            <>
              <p className="text-xs mt-1" style={{ color: 'var(--source-body)' }}>
                {upload.result.pages} pages → {upload.result.chunks} chunks
                {upload.result.embedded > 0 && `, ${upload.result.embedded} embedded`}
                {upload.result.searchable
                  ? ' — searchable'
                  : ' — NOT searchable (no embeddings)'}
              </p>
              {(upload.result.warnings || []).map((w, i) => (
                <p key={i} className="text-xs mt-1" style={{ color: '#b45309' }}>⚠ {w}</p>
              ))}
            </>
          )}
        </div>
      )}

      {/* Documents */}
      <div className="flex flex-col gap-2">
        {docs.length === 0 && (
          <p className="text-sm text-center py-6" style={{ color: 'var(--text-secondary)' }}>
            Nothing loaded yet. Add a document above.
          </p>
        )}

        {docs.map(d => (
          <div key={d.filename} className="rounded-lg overflow-hidden"
            style={{ background: 'var(--source-bg)', border: '1px solid var(--source-border)' }}>
            <div className="px-3 py-2 flex items-center gap-3">
              <button onClick={() => openChunks(d.filename)} className="flex-1 min-w-0 text-left">
                <p className="text-sm font-medium truncate" style={{ color: 'var(--source-title)' }}>
                  {expanded === d.filename ? '▾' : '▸'} {d.filename}
                </p>
                <p className="text-xs" style={{ color: 'var(--source-body)' }}>
                  {d.ingested ? `${d.chunks} chunks` : 'not ingested'}
                  {d.pages > 0 && ` · ${d.pages} pages`}
                  {d.analysed > 0 && ` · ${d.analysed} analysed`}
                  {d.bytes != null && ` · ${fmtBytes(d.bytes)}`}
                  {!d.hasFile && ' · file missing'}
                </p>
              </button>
              {d.hasFile && (
                <button
                  onClick={() => onOpenDoc({ filename: d.filename, page: 1 })}
                  className="text-xs px-2 py-1 rounded shrink-0 hover:opacity-80"
                  style={{ background: 'var(--chip-bg)', border: '1px solid var(--chip-border)', color: 'var(--chip-text)' }}
                >View</button>
              )}
            </div>

            {expanded === d.filename && (
              <div className="px-3 pb-3 flex flex-col gap-1.5 max-h-96 overflow-y-auto">
                {(chunks[d.filename] || []).map(c => (
                  <button
                    key={c.id}
                    onClick={() => c.pdfPage != null && onOpenDoc({
                      filename: d.filename,
                      page: c.pdfPage + 1,
                      printedPage: c.printedPage,
                      excerpt: c.preview.slice(0, 200),
                    })}
                    className="text-left rounded px-2 py-1.5 hover:opacity-80"
                    style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
                  >
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                      #{c.chunkIndex}
                      {c.pdfPage != null && ` · p.${c.pdfPage + 1}`}
                      {c.printedPage && ` (printed ${c.printedPage})`}
                      {c.difficulty && ` · ${c.difficulty}`}
                      {' · '}{c.chars} chars
                    </p>
                    {c.summary && (
                      <p className="text-xs mt-0.5" style={{ color: 'var(--source-body)' }}>{c.summary}</p>
                    )}
                    {!c.summary && (
                      <p className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--source-body)' }}>
                        {c.preview}
                      </p>
                    )}
                    {c.concepts?.length > 0 && (
                      <p className="text-xs mt-1" style={{ color: 'var(--chip-text)' }}>
                        {c.concepts.slice(0, 6).join(' · ')}
                      </p>
                    )}
                  </button>
                ))}
                {chunks[d.filename]?.length === 0 && (
                  <p className="text-xs py-2" style={{ color: 'var(--text-secondary)' }}>No chunks stored.</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
