import { useState, useEffect, useCallback, useRef } from 'react';

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

  async function doUpload(file) {
    if (!file || readOnly) return;
    setUpload({ filename: file.name, stage: 'start' });

    const body = new FormData();
    body.append('file', file);

    try {
      const res = await fetch(`/api/documents/${subject}/upload`, { method: 'POST', body });
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
        const frames = buf.split('\n\n');
        buf = frames.pop();
        for (const frame of frames) {
          if (!frame.startsWith('data: ')) continue;
          const ev = JSON.parse(frame.slice(6));
          if (ev.stage === 'error') { setUpload(u => ({ ...u, stage: 'error', error: ev.error })); return; }
          if (ev.stage === 'done') { setUpload({ filename: ev.result.filename, stage: 'done', result: ev.result }); onRefresh?.(); return; }
          setUpload(u => ({ ...u, ...ev }));
        }
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
          This knowledge area connects to an existing corpus and is <strong>read-only</strong> —
          documents cannot be added or removed through SageStack.
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
          <input ref={fileInput} type="file" accept=".pdf,.txt,.md,.json,.csv"
            style={{ display: 'none' }} onChange={e => doUpload(e.target.files?.[0])} />
          <div style={{ color: 'var(--ink)' }}>Drop a PDF here, or click to choose</div>
          <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 4 }}>
            PDF, TXT, MD, JSON, CSV — added to {current?.name || subject}
          </div>
        </div>
      )}

      {upload && (
        <div style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--panel)', border: '1px solid var(--line)', fontSize: 13.5 }}>
          <div>
            {upload.stage === 'error' ? '✕ ' : upload.stage === 'done' ? '✓ ' : '… '}
            <strong>{upload.filename}</strong>
            {upload.stage !== 'done' && upload.stage !== 'error' && ` — ${upload.stage}`}
            {upload.total ? ` ${upload.done ?? 0}/${upload.total}` : ''}
          </div>
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
                {/* Only offer the viewer when the source file is actually on
                    disk. Imported corpora have chunks but no file, and a View
                    button that 404s is worse than no button. */}
                {d.hasFile ? (
                  <button className="btn icon" onClick={() => onOpenDoc({ filename: d.filename, title: d.filename, page: 1 })}>
                    View
                  </button>
                ) : (
                  <span style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap' }} title="The chunks were imported without their source file, so there is nothing to open.">
                    no file
                  </span>
                )}
              </div>

              {expanded === d.filename && (
                <div style={{ padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 420, overflowY: 'auto' }}>
                  {(chunks[d.filename] || []).map(c => (
                    <button
                      key={c.id}
                      onClick={() => {
                        if (!d.hasFile || c.pdfPage == null) return;
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

      {/* Table of contents, where the corpus has one */}
      {sections.length > 0 && (
        <div>
          <div className="label-mini" style={{ marginBottom: 8 }}>Contents ({sections.length} sections)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {sections.map(s => (
              <button
                key={`${s.section}-${s.firstPage}`}
                className="chip"
                onClick={() => {
                  const doc = docs.find(d => d.hasFile) || docs[0];
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
