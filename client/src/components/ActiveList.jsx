import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { apiJson } from '../api';

/**
 * The strip under the header showing what the reader has nominated as current
 * — for Rx, the drugs they are taking.
 *
 * It sits above the conversation rather than in a panel because it changes what
 * every answer means. "What are the side effects" resolves against this list,
 * so it has to be visible while reading the answer, not somewhere you have to
 * go and check.
 *
 * Choices come from what the documents actually contain. Offering something
 * with nothing behind it produces an empty answer that reads as a bug.
 */
export default function ActiveList({ subject, onChange }) {
  const [state, setState] = useState(null);   // { filterKey, filterLabel, active, available, readOnly }
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const load = useCallback(() => {
    if (!subject) return;
    setError(null);
    fetch(`/api/settings?subject=${encodeURIComponent(subject)}`)
      .then(r => r.json())
      .then(d => setState(d.error ? null : d))
      .catch(() => setState(null));
  }, [subject]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (adding) inputRef.current?.focus(); }, [adding]);

  const save = useCallback(async (active) => {
    setState(s => ({ ...s, active }));          // optimistic; the list is small
    try {
      await apiJson(`/api/settings?subject=${encodeURIComponent(subject)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      onChange?.(active);
    } catch (err) {
      setError(err.message);
      load();                                    // roll back to what the server has
    }
  }, [subject, onChange, load]);

  const active = state?.active ?? [];

  const suggestions = useMemo(() => {
    if (!state?.available) return [];
    const q = query.trim().toLowerCase();
    return state.available
      .filter(a => !active.includes(a.term))
      .filter(a => !q || a.term.includes(q))
      .slice(0, 8);
  }, [state, query, active]);

  // Nothing to show unless the subject nominated a field to filter on.
  if (!state?.filterKey) return null;

  const add = (term) => {
    const t = String(term).trim().toLowerCase();
    if (!t || active.includes(t)) { setQuery(''); setAdding(false); return; }
    save([...active, t]);
    setQuery('');
    setAdding(false);
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap',
      padding: '7px 16px', borderBottom: '1px solid var(--line)',
      background: 'var(--panel)', position: 'relative',
    }}>
      <span className="label-mini" style={{ marginRight: 2 }}>
        {state.filterLabel === 'drugs' ? 'Taking' : `Current ${state.filterLabel}`}
      </span>

      {active.length === 0 && !adding && (
        <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
          nothing set — answers draw on everything loaded
        </span>
      )}

      {active.map(term => (
        <span key={term} className="chip" style={{ cursor: 'default', display: 'inline-flex', gap: 6 }}>
          {term}
          {!state.readOnly && (
            <span
              onClick={() => save(active.filter(t => t !== term))}
              title={`Remove ${term}`}
              style={{ cursor: 'pointer', color: 'var(--muted)' }}
            >×</span>
          )}
        </span>
      ))}

      {!state.readOnly && !adding && (
        <button className="chip" onClick={() => setAdding(true)}>+ Add</button>
      )}

      {adding && (
        <span style={{ position: 'relative' }}>
          <input
            ref={inputRef}
            className="field"
            value={query}
            placeholder={state.available?.length ? 'type to search…' : 'nothing loaded yet'}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') add(suggestions[0]?.term || query);
              if (e.key === 'Escape') { setQuery(''); setAdding(false); }
            }}
            onBlur={() => setTimeout(() => setAdding(false), 150)}
            style={{ fontSize: 12.5, padding: '4px 9px', width: 190 }}
          />
          {suggestions.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 30,
              background: 'var(--panel)', border: '1px solid var(--line)',
              borderRadius: 9, boxShadow: 'var(--shadow)', minWidth: 210, overflow: 'hidden',
            }}>
              {suggestions.map(s => (
                <button
                  key={s.term}
                  onMouseDown={() => add(s.term)}
                  className="hist"
                  style={{ borderRadius: 0, display: 'flex', justifyContent: 'space-between', gap: 10 }}
                >
                  <span>{s.term}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 11 }}>{s.chunks}</span>
                </button>
              ))}
            </div>
          )}
        </span>
      )}

      {error && <span style={{ fontSize: 11.5, color: '#f85149' }}>{error}</span>}
    </div>
  );
}
