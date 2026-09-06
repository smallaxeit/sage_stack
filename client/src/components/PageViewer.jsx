import { useEffect, useState, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Page preview, ported from ask_cooter: the scanned page on the left, the
 * extracted text on the right.
 *
 * The split is the point. A scan alone can't be searched or copied and a wiring
 * diagram is unreadable as plain text, so showing both means you can read the
 * clean version and still check it against what is actually printed.
 *
 * Falls back to the browser's PDF viewer for subjects ingested from a text-layer
 * PDF, which have no rendered page image.
 */
export default function PageViewer({ subject, doc, onClose }) {
  const [page, setPage] = useState(doc?.page ?? 1);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState(1);

  const scanRef = useRef(null);
  const panRef = useRef({ dragging: false, moved: false, x: 0, y: 0, left: 0, top: 0 });

  useEffect(() => { setPage(doc?.page ?? 1); }, [doc?.filename, doc?.page]);

  // Ask what this page is. Subjects with no page detail 404, and we fall back.
  useEffect(() => {
    if (!doc || !subject) return;
    let cancelled = false;
    setLoading(true);
    setZoom(1);
    fetch(`/api/documents/${encodeURIComponent(subject)}/page/${page - 1}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) { setDetail(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setDetail(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [subject, doc, page]);

  const step = useCallback((d) => setPage(p => Math.max(1, p + d)), []);

  useEffect(() => {
    if (!doc) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === '+' || e.key === '=') setZoom(z => Math.min(5, z * 1.25));
      else if (e.key === '-') setZoom(z => Math.max(1, z / 1.25));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc, onClose, step]);

  // Drag to pan once zoomed past fit.
  useEffect(() => {
    const el = scanRef.current;
    if (!el) return;
    const down = (e) => {
      if (zoom <= 1) return;
      panRef.current = { dragging: true, moved: false, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
      el.style.cursor = 'grabbing';
    };
    const move = (e) => {
      const p = panRef.current;
      if (!p.dragging) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) p.moved = true;
      el.scrollLeft = p.left - dx;
      el.scrollTop = p.top - dy;
    };
    const up = () => { panRef.current.dragging = false; el.style.cursor = zoom > 1 ? 'grab' : 'auto'; };
    el.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      el.removeEventListener('mousedown', down);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [zoom]);

  if (!doc) return null;

  const base = `/api/documents/${encodeURIComponent(subject)}/file/${encodeURIComponent(doc.filename || '')}`;
  const hasImage = !!detail?.hasImage;
  const hasText = !!detail?.markdown;
  const isPdf = /\.pdf$/i.test(doc.filename || '');
  const printed = detail?.printedPage ?? doc.printedPage;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="mhead">
          <span className="ttl" style={{ fontWeight: 600 }}>
            {doc.title || doc.filename || 'Page'}
          </span>
          <span className="meta" style={{ color: 'var(--muted)', fontSize: 12.5, marginRight: 'auto' }}>
            page {page}
            {printed && String(printed) !== String(page) && <> · printed <strong>{printed}</strong></>}
            {detail?.section && <> · {detail.section}</>}
          </span>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button className="btn icon" onClick={() => step(-1)} disabled={page <= 1}>‹ Prev</button>
            <input
              className="field"
              type="number"
              min="1"
              value={page}
              onChange={e => setPage(Math.max(1, Number(e.target.value) || 1))}
              style={{ width: 74, padding: '5px 8px', fontSize: 13, textAlign: 'center' }}
            />
            <button className="btn icon" onClick={() => step(1)}>Next ›</button>
          </div>

          {hasImage && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button className="btn icon" onClick={() => setZoom(z => Math.max(1, z / 1.25))}>−</button>
              <button className="btn icon" onClick={() => setZoom(1)}>Fit</button>
              <button className="btn icon" onClick={() => setZoom(z => Math.min(5, z * 1.25))}>+</button>
            </div>
          )}

          <a className="btn icon" href={base} target="_blank" rel="noreferrer">Open ↗</a>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        {doc.excerpt && (
          <div style={{
            padding: '8px 14px', fontSize: 12.5, color: 'var(--muted)',
            background: 'var(--chip)', borderBottom: '1px solid var(--line)',
            maxHeight: 90, overflowY: 'auto',
          }}>
            <span className="label-mini">Retrieved passage </span>{doc.excerpt}
          </div>
        )}

        <div className={`mbody ${hasImage && hasText ? '' : 'single'}`}>
          {hasImage && (
            <div className="scan" ref={scanRef}>
              <img
                src={`/api/documents/${encodeURIComponent(subject)}/page-image/${page - 1}`}
                alt={`Scan of page ${page}`}
                draggable={false}
                onClick={() => { if (!panRef.current.moved) setZoom(z => (z > 1 ? 1 : 2.2)); panRef.current.moved = false; }}
                style={{
                  width: `${zoom * 100}%`,
                  maxWidth: zoom > 1 ? 'none' : '100%',
                  cursor: zoom > 1 ? 'grab' : 'zoom-in',
                }}
              />
            </div>
          )}

          {hasText ? (
            <div className="text">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.markdown}</ReactMarkdown>

              {detail.specs?.length > 0 && (
                <>
                  <div className="label-mini" style={{ marginTop: 16, marginBottom: 6 }}>Specifications</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <tbody>
                      {detail.specs.map((s, i) => (
                        <tr key={i}>
                          <td style={{ border: '1px solid var(--line)', padding: '5px 9px' }}>{s.name}</td>
                          <td style={{ border: '1px solid var(--line)', padding: '5px 9px', whiteSpace: 'nowrap' }}>
                            {s.value}{s.unit ? ` ${s.unit}` : ''}
                          </td>
                          <td style={{ border: '1px solid var(--line)', padding: '5px 9px', color: 'var(--muted)' }}>{s.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {detail.diagrams?.length > 0 && (
                <>
                  <div className="label-mini" style={{ marginTop: 16, marginBottom: 6 }}>Figures</div>
                  {detail.diagrams.map((d, i) => (
                    <p key={i} style={{ fontSize: 13, margin: '.4em 0' }}>
                      <strong>{d.figure || `Figure ${i + 1}`}</strong>
                      {d.title ? ` — ${d.title}` : ''}
                      {d.description ? <span style={{ color: 'var(--muted)' }}>: {d.description}</span> : null}
                    </p>
                  ))}
                </>
              )}
            </div>
          ) : loading ? (
            <div className="text" style={{ color: 'var(--muted)' }}>Loading page…</div>
          ) : isPdf ? (
            // No page detail: a text-layer PDF with no rendered scan. Re-keyed
            // per page because browsers ignore a fragment-only src change.
            <iframe
              key={`${doc.filename}-${page}`}
              src={`${base}#page=${page}&view=FitH`}
              title={doc.filename}
              style={{ border: 'none', width: '100%', height: '70vh', background: '#fff' }}
            />
          ) : (
            <div className="text" style={{ color: 'var(--muted)' }}>
              <p><strong>No preview available.</strong></p>
              <p>
                This document's chunks are in the knowledge base, but its source file is not
                stored locally — imported corpora carry their text and embeddings without the
                original. There is no page to show.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
