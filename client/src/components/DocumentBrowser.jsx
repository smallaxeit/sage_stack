import { useState, useEffect, useCallback, useMemo } from 'react';

/**
 * Browse a subject's documents directly, rather than only landing where a
 * citation points.
 *
 * The distinction matters: a citation answers "where did that claim come
 * from", and this answers "what is actually in here" — reading a procedure
 * through, checking the page before and after a spec table, finding a section
 * you half remember. ask_cooter's viewer is the reference, extended with a
 * section index and chunk search because SageStack holds several documents per
 * subject rather than one.
 */

const fmtBytes = (n) => {
  if (n == null) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
};

export default function DocumentBrowser({ subject, docs = [], onOpenDoc }) {
  const [selected, setSelected] = useState(null);
  const [chunks, setChunks] = useState([]);
  const [sections, setSections] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);

  // Default to the document with the most content — usually the one wanted.
  useEffect(() => {
    setSelected(prev => (docs.some(d => d.filename === prev) ? prev : docs[0]?.filename ?? null));
  }, [docs]);

  useEffect(() => { setFilter(''); }, [selected, subject]);

  useEffect(() => {
    if (!subject) return;
    fetch(`/api/documents/${subject}/sections`)
      .then(r => r.json()).then(d => setSections(d.sections || [])).catch(() => setSections([]));
  }, [subject]);

  useEffect(() => {
    if (!subject || !selected) { setChunks([]); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/documents/${subject}/chunks/${encodeURIComponent(selected)}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) { setChunks(d.chunks || []); setLoading(false); } })
      .catch(() => { if (!cancelled) { setChunks([]); setLoading(false); } });
    return () => { cancelled = true; };
  }, [subject, selected]);

  const doc = docs.find(d => d.filename === selected);

  /**
   * Plain substring matching over the stored text, deliberately — this is
   * "find the page that mentions X", which is a different question from the
   * semantic search the chat uses, and the literal answer is the useful one
   * when you already know the wording.
   */
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return chunks;
    return chunks.filter(c =>
      c.preview?.toLowerCase().includes(q) ||
      c.summary?.toLowerCase().includes(q) ||
      (c.concepts || []).some(x => x.toLowerCase().includes(q)) ||
      String(c.printedPage ?? '').toLowerCase() === q);
  }, [chunks, filter]);

  const open = useCallback((page, excerpt, printedPage) => {
    if (!doc?.viewable) return;
    onOpenDoc({ filename: doc.filename, title: doc.filename, page, printedPage, excerpt });
  }, [doc, onOpenDoc]);

  if (docs.length === 0) {
    return (
      <div style={{ padding: '20px 40px', color: 'var(--muted)' }}>
        Nothing loaded in this knowledge area yet.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* Document list */}
      <div style={{
        width: 240, flex: 'none', borderRight: '1px solid var(--line)',
        overflowY: 'auto', padding: '10px 8px',
      }}>
        <div className="label-mini" style={{ padding: '0 6px 8px' }}>Documents</div>
        {docs.map(d => (
          <button
            key={d.filename}
            className={`hist ${d.filename === selected ? 'active' : ''}`}
            onClick={() => setSelected(d.filename)}
            title={d.filename}
            style={{ whiteSpace: 'normal' }}
          >
            <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {d.filename}
            </span>
            <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>
              {d.chunks.toLocaleString()} chunks
              {d.pages > 0 && ` · ${d.pages.toLocaleString()} pages`}
              {!d.viewable && ' · no preview'}
            </span>
          </button>
        ))}
      </div>

      {/* Selected document */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 22px', minWidth: 0 }}>
        {doc && (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: 16, margin: 0 }}>{doc.filename}</h2>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                {doc.chunks.toLocaleString()} chunks
                {doc.pages > 0 && ` · ${doc.pages.toLocaleString()} pages`}
                {doc.analyzed > 0 && ` · ${doc.analyzed.toLocaleString()} analyzed`}
                {fmtBytes(doc.bytes) && ` · ${fmtBytes(doc.bytes)}`}
              </span>
              {doc.viewable && (
                <button className="btn icon" onClick={() => open(1)}>Open at page 1</button>
              )}
            </div>

            {!doc.viewable && (
              <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 6 }}>
                No preview: this document's chunks are stored, but neither the original file nor
                page scans are available, so there is no page to display.
              </p>
            )}

            {/* Sections, where the corpus has them */}
            {sections.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div className="label-mini" style={{ marginBottom: 6 }}>
                  Contents ({sections.length})
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {sections.map(s => (
                    <button
                      key={`${s.section}-${s.firstPage}`}
                      className="chip"
                      onClick={() => open(s.firstPage + 1)}
                      disabled={!doc.viewable}
                    >
                      {s.section}<span className="score">p.{s.firstPage + 1}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div style={{ marginTop: 16, marginBottom: 10 }}>
              <input
                className="field"
                placeholder="Find in this document — a phrase, a concept, or a printed page number"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                style={{ width: '100%', fontSize: 13 }}
              />
              {filter && (
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
                  {shown.length} of {chunks.length} chunks
                </div>
              )}
            </div>

            {loading && <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {shown.map(c => (
                <button
                  key={c.id}
                  onClick={() => open((c.pdfPage ?? 0) + 1, c.preview?.slice(0, 220), c.printedPage)}
                  disabled={!doc.viewable || c.pdfPage == null}
                  style={{
                    textAlign: 'left', background: 'var(--panel)', border: '1px solid var(--line)',
                    borderRadius: 9, padding: '9px 12px', font: 'inherit',
                    cursor: doc.viewable && c.pdfPage != null ? 'pointer' : 'default',
                  }}
                >
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    #{c.chunkIndex}
                    {c.pdfPage != null && ` · p.${c.pdfPage + 1}`}
                    {c.printedPage && ` (printed ${c.printedPage})`}
                    {c.difficulty && ` · ${c.difficulty}`}
                    {` · ${c.chars} chars`}
                  </div>
                  <div style={{ fontSize: 13.5, marginTop: 3 }}>
                    {c.summary || `${(c.preview || '').slice(0, 220)}…`}
                  </div>
                  {c.concepts?.length > 0 && (
                    <div style={{ fontSize: 11.5, color: 'var(--accent)', marginTop: 4 }}>
                      {c.concepts.slice(0, 8).join(' · ')}
                    </div>
                  )}
                </button>
              ))}
              {!loading && shown.length === 0 && (
                <p style={{ color: 'var(--muted)', fontSize: 13 }}>
                  {filter ? 'Nothing matches that.' : 'No chunks stored for this document.'}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
