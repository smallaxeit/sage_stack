import { useEffect, useState } from 'react';

/**
 * PageViewer — opens a source at the page a citation came from.
 *
 * Two backends, chosen automatically per subject:
 *
 *  - a vision-ingested corpus stores a rendered PNG per page, which is the
 *    exact image the model read. For a scanned manual there is often no
 *    text-layer PDF to fall back on at all, so this is the only way to show
 *    the source.
 *  - otherwise the original PDF is opened in the browser's own viewer at
 *    #page=N, so no PDF library ships to the client.
 *
 * It probes the page endpoint on open rather than being told which to use,
 * because the caller (a chat citation, a chunk row) has no idea how its subject
 * was ingested.
 *
 * pdfPage and printedPage are both shown when they differ — they diverge
 * wherever a document has front matter.
 */
export default function PageViewer({ subject, doc, onClose }) {
  const [page, setPage] = useState(doc?.page ?? 1);
  const [detail, setDetail] = useState(null);   // { hasImage, section, printedPage, specs, diagrams }
  const [probed, setProbed] = useState(false);

  useEffect(() => { setPage(doc?.page ?? 1); }, [doc?.filename, doc?.page]);

  // Ask what this page actually is. A subject with no page detail (a plain
  // text-ingested PDF) simply 404s, and we fall back to the PDF viewer.
  useEffect(() => {
    if (!doc || !subject) return;
    let cancelled = false;
    setProbed(false);
    fetch(`/api/documents/${encodeURIComponent(subject)}/page/${page - 1}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) { setDetail(d); setProbed(true); } })
      .catch(() => { if (!cancelled) { setDetail(null); setProbed(true); } });
    return () => { cancelled = true; };
  }, [subject, doc, page]);

  useEffect(() => {
    if (!doc) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
      if (e.key === 'ArrowLeft')  setPage(p => Math.max(1, p - 1));
      if (e.key === 'ArrowRight') setPage(p => p + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc, onClose]);

  if (!doc) return null;

  const base = `/api/documents/${encodeURIComponent(subject)}/file/${encodeURIComponent(doc.filename)}`;
  const isPdf = /\.pdf$/i.test(doc.filename);
  const useImage = detail?.hasImage;
  const printed = detail?.printedPage ?? doc.printedPage;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full max-w-5xl h-[90vh] rounded-xl flex flex-col overflow-hidden shadow-2xl"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 px-4 py-3 shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
              {doc.title || doc.filename}
            </p>
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              page {page}
              {printed && String(printed) !== String(page) && <> · printed <strong>{printed}</strong></>}
              {detail?.section && <> · {detail.section}</>}
            </p>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => setPage(p => Math.max(1, p - 1))}
              className="px-2 py-1 rounded text-sm hover:opacity-80"
              style={{ background: 'var(--chip-bg)', border: '1px solid var(--chip-border)', color: 'var(--chip-text)' }}
              aria-label="Previous page">←</button>
            <input type="number" min="1" value={page}
              onChange={e => setPage(Math.max(1, Number(e.target.value) || 1))}
              className="w-16 px-2 py-1 rounded text-sm text-center"
              style={{ background: 'var(--surface-user)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
              aria-label="Page number" />
            <button onClick={() => setPage(p => p + 1)}
              className="px-2 py-1 rounded text-sm hover:opacity-80"
              style={{ background: 'var(--chip-bg)', border: '1px solid var(--chip-border)', color: 'var(--chip-text)' }}
              aria-label="Next page">→</button>
          </div>

          <button onClick={onClose} className="text-xl leading-none px-2 shrink-0 hover:opacity-70"
            style={{ color: 'var(--text-secondary)' }} aria-label="Close">×</button>
        </header>

        {doc.excerpt && (
          <div className="px-4 py-2 text-xs shrink-0 max-h-24 overflow-y-auto"
            style={{ background: 'var(--source-bg)', borderBottom: '1px solid var(--border)', color: 'var(--source-body)' }}>
            <span style={{ color: 'var(--source-title)' }}>Retrieved passage: </span>
            {doc.excerpt}
          </div>
        )}

        <div className="flex-1 overflow-auto" style={{ background: '#fff' }}>
          {!probed ? (
            <p className="text-sm text-center py-8" style={{ color: '#666' }}>Loading page…</p>
          ) : useImage ? (
            <img
              src={`/api/documents/${encodeURIComponent(subject)}/page-image/${page - 1}`}
              alt={`Page ${page}`}
              className="w-full h-auto block"
            />
          ) : isPdf ? (
            // Re-keyed per page: browsers do not reliably re-navigate on a
            // fragment-only change to an otherwise identical src.
            <iframe key={`${doc.filename}-${page}`} src={`${base}#page=${page}&view=FitH`}
              title={doc.filename} className="w-full h-full" style={{ border: 'none', minHeight: '100%' }} />
          ) : (
            <iframe key={doc.filename} src={base} title={doc.filename}
              className="w-full h-full" style={{ border: 'none', minHeight: '100%' }} />
          )}
        </div>

        {/* Specs and figures the vision pass pulled off this page. */}
        {(detail?.specs?.length > 0 || detail?.diagrams?.length > 0) && (
          <div className="px-4 py-2 text-xs shrink-0 max-h-32 overflow-y-auto"
            style={{ background: 'var(--source-bg)', borderTop: '1px solid var(--border)', color: 'var(--source-body)' }}>
            {detail.specs?.length > 0 && (
              <p><span style={{ color: 'var(--source-title)' }}>Specs: </span>
                {detail.specs.map(s => `${s.name}: ${s.value}${s.unit ? ' ' + s.unit : ''}`).join(' · ')}</p>
            )}
            {detail.diagrams?.length > 0 && (
              <p className="mt-1"><span style={{ color: 'var(--source-title)' }}>Figures: </span>
                {detail.diagrams.map(d => d.figure || d.title).filter(Boolean).join(' · ')}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
