import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function Message({ role, content, sources = [], chips = [], onChipClick, onOpenDoc }) {
  const isUser = role === 'user';
  const [sourcesOpen, setSourcesOpen] = useState(false);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      {!isUser && (
        <img src="/avatar.png" alt="Sage" className="w-8 h-8 rounded-full object-cover mr-3 mt-1 shrink-0 shadow" style={{ border: '1px solid var(--avatar-border)' }} />
      )}

      <div className="flex flex-col gap-2 max-w-[75%]">
        {/* Bubble */}
        <div
          className={`px-4 py-3 rounded-2xl text-sm leading-relaxed ${
            isUser
              ? 'rounded-br-sm whitespace-pre-wrap'
              : 'rounded-bl-sm prose prose-sm prose-invert max-w-none'
          }`}
          style={isUser
            ? { background: 'var(--surface-user)', color: 'var(--text-primary)', border: '1px solid var(--border)' }
            : { background: 'var(--surface-ai)', color: 'var(--text-primary)', border: '1px solid var(--border-accent)' }
          }
        >
          {isUser ? content : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
                em: ({ children }) => <em className="italic text-slate-200">{children}</em>,
                ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-1">{children}</ol>,
                li: ({ children }) => <li>{children}</li>,
                h1: ({ children }) => <h1 className="text-base font-bold text-white mb-1">{children}</h1>,
                h2: ({ children }) => <h2 className="text-sm font-bold text-white mb-1">{children}</h2>,
                h3: ({ children }) => <h3 className="text-sm font-semibold text-slate-100 mb-1">{children}</h3>,
                blockquote: ({ children }) => <blockquote className="border-l-2 border-slate-500 pl-3 italic text-slate-300 my-2">{children}</blockquote>,
                code: ({ children }) => <code className="bg-blue-900/60 px-1 rounded text-slate-200 text-xs">{children}</code>,
                table: ({ children }) => <table className="border-collapse w-full my-2 text-xs">{children}</table>,
                thead: ({ children }) => <thead className="border-b border-slate-600">{children}</thead>,
                th: ({ children }) => <th className="text-left px-2 py-1 font-semibold text-white">{children}</th>,
                td: ({ children }) => <td className="px-2 py-1 border-t border-blue-800/40">{children}</td>,
              }}
            >
              {content}
            </ReactMarkdown>
          )}
        </div>

        {/* Chips — explore this */}
        {!isUser && chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chips.map(chip => (
              <button
                key={chip}
                onClick={() => onChipClick?.(chip)}
                className="text-xs px-2.5 py-1 rounded-full transition-colors hover:opacity-80"
                style={{ background: 'var(--chip-bg)', border: '1px solid var(--chip-border)', color: 'var(--chip-text)' }}
              >
                📖 {chip}
              </button>
            ))}
          </div>
        )}

        {/* Sources */}
        {!isUser && sources.length > 0 && (
          <div>
            <button
              onClick={() => setSourcesOpen(o => !o)}
              className="text-xs text-blue-600 hover:text-blue-400 transition-colors flex items-center gap-1"
            >
              <span>{sourcesOpen ? '▾' : '▸'}</span>
              <span>📚 {sources.length} source{sources.length !== 1 ? 's' : ''}</span>
            </button>
            {sourcesOpen && (
              <div className="mt-1.5 flex flex-col gap-1.5">
                {sources.map((s, i) => {
                  // A citation is only worth showing if it can be checked, so a
                  // source that carried a page number opens that exact page.
                  const canOpen = !!onOpenDoc && !!s.filename;
                  const Tag = canOpen ? 'button' : 'div';
                  return (
                    <Tag
                      key={i}
                      onClick={canOpen ? () => onOpenDoc({
                        filename: s.filename,
                        title: s.source,
                        page: s.page || 1,
                        printedPage: s.printedPage,
                        excerpt: s.preview,
                      }) : undefined}
                      className={`rounded-lg px-3 py-2 text-left w-full ${canOpen ? 'hover:opacity-80 cursor-pointer' : ''}`}
                      style={{ background: 'var(--source-bg)', border: '1px solid var(--source-border)' }}
                    >
                      <p className="text-xs font-medium mb-0.5" style={{ color: 'var(--source-title)' }}>
                        {s.source}
                        {s.page ? ` · p.${s.page}` : ''}
                        {s.printedPage && String(s.printedPage) !== String(s.page) ? ` (printed ${s.printedPage})` : ''}
                        {canOpen ? ' ↗' : ''}
                      </p>
                      <p className="text-xs leading-relaxed line-clamp-2" style={{ color: 'var(--source-body)' }}>{s.preview}…</p>
                    </Tag>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {isUser && (
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ml-3 mt-1 shrink-0"
          style={{ background: 'var(--surface-user)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
          U
        </div>
      )}
    </div>
  );
}
