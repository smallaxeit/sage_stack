import { useEffect, useState } from 'react';

/**
 * PageViewer — opens a source document at the page a citation came from.
 *
 * Uses the browser's built-in PDF viewer via an iframe and a #page=N fragment,
 * so there is no PDF library to ship. The iframe is re-keyed on every page
 * change because browsers do not reliably re-navigate on a fragment-only change
 * to a src that is otherwise identical.
 *
 * Two page numbers are shown when they differ: the position in the file (what
 * the viewer jumps to) and the label printed on the page itself. They diverge
 * wherever a document has front matter — in the sample Torah PDF, by 17 pages.
 */
export default function PageViewer({ subject, doc, onClose }) {
  const [page, setPage] = useState(doc?.page ?? 1);

  useEffect(() => { setPage(doc?.page ?? 1); }, [doc?.filename, doc?.page]);

  // Escape closes, arrows page — expected of anything that behaves like a viewer.
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
  const src = isPdf ? `${base}#page=${page}&view=FitH` : base;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl h-[90vh] rounded-xl flex flex-col overflow-hidden shadow-2xl"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        onClick={e => e.stopPropagation()}
      >
        <header
          className="flex items-center gap-3 px-4 py-3 shrink-0"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
              {doc.title || doc.filename}
            </p>
            {isPdf && (
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                page {page}
                {doc.printedPage && String(doc.printedPage) !== String(page) && (
                  <> · printed <strong>{doc.printedPage}</strong></>
                )}
              </p>
            )}
          </div>

          {isPdf && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                className="px-2 py-1 rounded text-sm hover:opacity-80"
                style={{ background: 'var(--chip-bg)', border: '1px solid var(--chip-border)', color: 'var(--chip-text)' }}
                aria-label="Previous page"
              >←</button>
              <input
                type="number"
                min="1"
                value={page}
                onChange={e => setPage(Math.max(1, Number(e.target.value) || 1))}
                className="w-16 px-2 py-1 rounded text-sm text-center"
                style={{ background: 'var(--surface-user)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                aria-label="Page number"
              />
              <button
                onClick={() => setPage(p => p + 1)}
                className="px-2 py-1 rounded text-sm hover:opacity-80"
                style={{ background: 'var(--chip-bg)', border: '1px solid var(--chip-border)', color: 'var(--chip-text)' }}
                aria-label="Next page"
              >→</button>
            </div>
          )}

          <a
            href={base}
            target="_blank"
            rel="noreferrer"
            className="text-xs px-2 py-1 rounded hover:opacity-80 shrink-0"
            style={{ background: 'var(--chip-bg)', border: '1px solid var(--chip-border)', color: 'var(--chip-text)' }}
          >Open ↗</a>
          <button
            onClick={onClose}
            className="text-xl leading-none px-2 shrink-0 hover:opacity-70"
            style={{ color: 'var(--text-secondary)' }}
            aria-label="Close"
          >×</button>
        </header>

        {doc.excerpt && (
          <div
            className="px-4 py-2 text-xs shrink-0 max-h-24 overflow-y-auto"
            style={{ background: 'var(--source-bg)', borderBottom: '1px solid var(--border)', color: 'var(--source-body)' }}
          >
            <span style={{ color: 'var(--source-title)' }}>Retrieved passage: </span>
            {doc.excerpt}
          </div>
        )}

        <iframe
          key={`${doc.filename}-${page}`}
          src={src}
          title={doc.filename}
          className="flex-1 w-full"
          style={{ border: 'none', background: '#fff' }}
        />
      </div>
    </div>
  );
}
