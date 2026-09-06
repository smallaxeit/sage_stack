import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * One chat turn, in ask_cooter's shape: a small uppercase role label above a
 * bordered bubble, user turns tinted.
 *
 * The important behaviour is inline citation linking. The model is instructed
 * to cite pages as [p.419], and those become clickable links that open the page
 * viewer at that scan. That is what makes an answer checkable in one click
 * rather than "go find it yourself" — and it is why the source list below is a
 * fallback rather than the main affordance.
 */

// [p.419], [p.419 (printed 401)], [PDF p.419] — the bracket form the prompt asks for.
const CITE = /\[(?:PDF\s+)?p\.\s*(\d+)([^\]]*)\]/gi;

function CitationText({ text, onOpenCite }) {
  const parts = useMemo(() => {
    const out = [];
    let last = 0;
    let m;
    CITE.lastIndex = 0;
    while ((m = CITE.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push({ page: Number(m[1]), label: m[0] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }, [text]);

  return parts.map((p, i) =>
    typeof p === 'string' ? p : (
      <a
        key={i}
        className="cite"
        onClick={(e) => { e.preventDefault(); onOpenCite?.(p.page); }}
        href="#"
      >{p.label}</a>
    ),
  );
}

export default function Message({
  role, content, sources = [], chips = [], streaming = false,
  onChipClick, onOpenDoc, onOpenCite,
}) {
  const isUser = role === 'user';

  // Rewrite bracketed page citations inside rendered markdown text nodes.
  const components = useMemo(() => {
    if (isUser) return {};
    const withCites = (children) =>
      Array.isArray(children)
        ? children.map((c, i) =>
            typeof c === 'string'
              ? <CitationText key={i} text={c} onOpenCite={onOpenCite} />
              : c)
        : (typeof children === 'string'
            ? <CitationText text={children} onOpenCite={onOpenCite} />
            : children);
    return {
      p:  ({ children }) => <p>{withCites(children)}</p>,
      li: ({ children }) => <li>{withCites(children)}</li>,
      td: ({ children }) => <td>{withCites(children)}</td>,
    };
  }, [isUser, onOpenCite]);

  return (
    <div className={`msg ${isUser ? 'user' : ''}`}>
      <div className="role">{isUser ? 'You' : 'Sage'}</div>

      <div className={`bubble ${streaming && !content ? 'blink' : ''}`}>
        {isUser ? (
          <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{content}</p>
        ) : (
          <>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {content}
            </ReactMarkdown>
            {streaming && content && <span className="blink" />}
          </>
        )}
      </div>

      {!isUser && chips.length > 0 && (
        <div className="sources" style={{ marginTop: 10 }}>
          <div className="label-mini" style={{ marginBottom: 6 }}>Explore</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {chips.map(chip => (
              <button key={chip} className="chip" onClick={() => onChipClick?.(chip)}>{chip}</button>
            ))}
          </div>
        </div>
      )}

      {!isUser && sources.length > 0 && (
        <div className="sources" style={{ marginTop: 10 }}>
          <div className="label-mini" style={{ marginBottom: 6 }}>
            Sources — click to open the page
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            {sources.map((s, i) => (
              <button
                key={i}
                className="chip"
                title={s.preview}
                onClick={() => onOpenDoc?.({
                  filename: s.filename,
                  title: s.source,
                  page: s.page || 1,
                  printedPage: s.printedPage,
                  excerpt: s.preview,
                })}
              >
                {s.source}
                {s.page ? <span className="score">p.{s.page}</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
