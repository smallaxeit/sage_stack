import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Admin panel — a slide-out control surface, scoped to the active subject.
 *
 * Two things differ from the version this replaces:
 *
 *  - It is PER SUBJECT. Subjects are tenants, so a global "works loaded" count
 *    is meaningless and a global action is dangerous. Every request names one.
 *  - The admin key is NOT hardcoded. The previous version shipped
 *    `const ADMIN_KEY = 'sagestack-admin-2026'` in the client bundle, handing
 *    it to anyone who opened the page. It is now asked for only when the
 *    server actually rejects a request, and kept in localStorage.
 *
 * Cost estimates are computed from the subject's real chunk counts rather than
 * quoted as fixed figures, because they scale with the corpus and a stale
 * number is worse than none.
 */

// Published per-million-token rates, used only to estimate before you spend.
const RATE = {
  voyage:      0.06,          // voyage-3.5
  haikuIn:     1.00, haikuOut: 5.00,
  sonnetIn:    2.00, sonnetOut: 10.00,
};
const TOKENS_PER_CHUNK = 350;   // ~1400 chars at 4 chars/token

const money = (n) => (n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

function Stat({ label, value, sub, tone }) {
  return (
    <div className="admin-stat">
      <div className="v" style={tone ? { color: tone } : undefined}>{value ?? '—'}</div>
      <div className="l">{label}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

function Bar({ pct }) {
  return <div className="admin-bar"><div style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} /></div>;
}

export default function AdminPanel({ open, onClose, subject, current, docs = [], onRefresh }) {
  const [tab, setTab] = useState('status');
  const [adminKey, setAdminKey] = useState(() => localStorage.getItem('ss-admin-key') || '');
  const [needKey, setNeedKey] = useState(false);
  const [msg, setMsg] = useState(null);          // { text, kind }
  const [build, setBuild] = useState(null);
  const [conceptMap, setConceptMap] = useState(null);
  const pollRef = useRef(null);

  const readOnly = !!current?.readOnly;

  const api = useCallback(async (path, opts = {}) => {
    const res = await fetch(`/api${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(adminKey ? { 'x-admin-key': adminKey } : {}),
        ...(opts.headers || {}),
      },
    });
    if (res.status === 401) { setNeedKey(true); throw new Error('Admin key required'); }
    return res.json();
  }, [adminKey]);

  // Poll while anything is running. Stops as soon as nothing is.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    async function tick() {
      try {
        const [b, c] = await Promise.all([
          fetch('/api/build-progress').then(r => r.json()).catch(() => null),
          fetch('/api/admin/concept-map-progress', {
            headers: adminKey ? { 'x-admin-key': adminKey } : {},
          }).then(r => r.json()).catch(() => null),
        ]);
        if (!alive) return;
        setBuild(b);
        setConceptMap(c);
        const running = b?.status === 'running' || (c && c.stage && c.stage !== 'idle' && !c.finishedAt);
        if (running) pollRef.current = setTimeout(tick, 1500);
        else if (b?.status === 'done') onRefresh?.();
      } catch { /* transient */ }
    }
    tick();
    return () => { alive = false; clearTimeout(pollRef.current); };
  }, [open, adminKey, onRefresh]);

  async function run(path, label) {
    setMsg({ text: `${label}…`, kind: 'info' });
    try {
      const r = await api(`${path}?subject=${encodeURIComponent(subject)}`, { method: 'POST' });
      setMsg({ text: r.message || (r.ok ? 'Started' : 'Refused'), kind: r.ok ? 'info' : 'warn' });
      if (r.ok) pollRef.current = setTimeout(() => {}, 0);
    } catch (err) {
      setMsg({ text: err.message, kind: 'err' });
    }
  }

  if (!open) return null;

  const chunks = current?.chunks ?? 0;
  const embedded = current?.withEmbedding ?? 0;
  const unembedded = Math.max(0, chunks - embedded);
  const embPct = chunks > 0 ? Math.round((embedded / chunks) * 100) : 0;

  const analyzed = docs.reduce((n, d) => n + (d.analyzed || 0), 0);
  const anaPct = chunks > 0 ? Math.round((analyzed / chunks) * 100) : 0;
  const unanalysed = Math.max(0, chunks - analyzed);

  const costEmbed = (unembedded * TOKENS_PER_CHUNK / 1e6) * RATE.voyage;
  const costAnalyse = (unanalysed * TOKENS_PER_CHUNK / 1e6) * RATE.haikuIn
                    + (unanalysed * 200 / 1e6) * RATE.haikuOut;
  const costMap = (20000 / 1e6) * RATE.sonnetIn + (16000 / 1e6) * RATE.sonnetOut;

  const buildRunning = build?.status === 'running';
  const mapRunning = conceptMap?.stage && conceptMap.stage !== 'idle' && !conceptMap.finishedAt;

  return (
    <>
      <div className="admin-backdrop" onClick={onClose} />
      <div className="admin-panel">
        <div className="admin-head">
          <strong style={{ marginRight: 'auto' }}>Admin — {current?.name || subject || 'no subject'}</strong>
          <button className="btn icon" onClick={onClose}>✕</button>
        </div>

        <div className="admin-tabs">
          {['status', 'sources', 'actions'].map(t => (
            <button key={t} className={`admin-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <div className="admin-body">
          {needKey && (
            <div className="admin-note warn">
              <div style={{ marginBottom: 6 }}>This server requires an admin key.</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="field"
                  type="password"
                  placeholder="ADMIN_KEY"
                  style={{ flex: 1, fontSize: 13, padding: '6px 9px' }}
                  onKeyDown={e => {
                    if (e.key !== 'Enter') return;
                    const v = e.target.value.trim();
                    if (!v) return;
                    localStorage.setItem('ss-admin-key', v);
                    setAdminKey(v);
                    setNeedKey(false);
                    setMsg({ text: 'Key saved — retry the action', kind: 'info' });
                  }}
                />
              </div>
            </div>
          )}

          {msg && <div className={`admin-note ${msg.kind === 'err' ? 'err' : msg.kind === 'warn' ? 'warn' : ''}`}>{msg.text}</div>}

          {/* ─── STATUS ─────────────────────────────────────────────────── */}
          {tab === 'status' && (
            <>
              <div className="admin-grid">
                <Stat label="Documents" value={docs.filter(d => d.ingested).length} />
                <Stat label="Chunks" value={chunks.toLocaleString()} />
                <Stat
                  label="Searchable"
                  value={embedded.toLocaleString()}
                  tone={chunks > 0 && embedded === 0 ? '#d29922' : undefined}
                  sub={unembedded > 0 ? `${unembedded.toLocaleString()} unembedded` : 'all embedded'}
                />
                <Stat label="Store" value={current?.storeDriver || '—'} sub={readOnly ? 'read-only' : undefined} />
              </div>

              <div>
                <div className="admin-row"><span>Embeddings</span><span>{embPct}%</span></div>
                <Bar pct={embPct} />
                <div className="s" style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
                  {current?.embedModel || 'model not recorded'} · {current?.dim || '?'} dims
                </div>
              </div>

              <div>
                <div className="admin-row"><span>Analyzed</span><span>{anaPct}%</span></div>
                <Bar pct={anaPct} />
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
                  Concepts and summaries. Retrieval works without it; concept maps do not.
                </div>
              </div>

              {current?.storeError && <div className="admin-note err">{current.storeError}</div>}

              {buildRunning && (
                <div>
                  <div className="admin-row">
                    <span>Building — {build.file || '…'}</span>
                    <span>{build.current}/{build.total}</span>
                  </div>
                  <Bar pct={build.pct || 0} />
                  {build.stage && (
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
                      {build.stage}{build.stageTotal ? ` ${build.stageDone ?? 0}/${build.stageTotal}` : ''}
                    </div>
                  )}
                </div>
              )}

              {mapRunning && (
                <div className="admin-note">Concept map: {conceptMap.stage}
                  {conceptMap.concepts ? ` — ${conceptMap.concepts} concepts` : ''}</div>
              )}
              {conceptMap?.error && <div className="admin-note err">Concept map: {conceptMap.error}</div>}
            </>
          )}

          {/* ─── SOURCES ────────────────────────────────────────────────── */}
          {tab === 'sources' && (
            docs.length === 0
              ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>No documents loaded.</p>
              : docs.map(d => {
                  const pct = d.chunks > 0 ? Math.round((d.analyzed / d.chunks) * 100) : 0;
                  return (
                    <div key={d.filename}>
                      <div className="admin-row">
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {d.filename}
                        </span>
                        <span style={{ color: pct === 100 ? '#3fb950' : 'var(--muted)', whiteSpace: 'nowrap' }}>
                          {pct === 100 ? '✓ analyzed' : `${pct}%`}
                        </span>
                      </div>
                      <Bar pct={pct} />
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3, marginBottom: 10 }}>
                        {d.chunks.toLocaleString()} chunks
                        {d.pages > 0 && ` · ${d.pages.toLocaleString()} pages`}
                        {!d.hasFile && ' · no local file'}
                      </div>
                    </div>
                  );
                })
          )}

          {/* ─── ACTIONS ────────────────────────────────────────────────── */}
          {tab === 'actions' && (
            readOnly ? (
              <div className="admin-note">
                <strong>{current.name}</strong> connects to an existing corpus and is read-only.
                Nothing here can be rebuilt through SageStack.
              </div>
            ) : (
              <>
                <div className="admin-action">
                  <div style={{ flex: 1 }}>
                    <div className="t">Build embeddings</div>
                    <div className="d">
                      Embed the {unembedded.toLocaleString()} chunk{unembedded === 1 ? '' : 's'} that have no
                      vector. Until they do, they cannot be retrieved.
                      {unembedded > 0 && <> <span className="cost">≈{money(costEmbed)}</span></>}
                    </div>
                  </div>
                  <button className="btn" disabled={unembedded === 0} onClick={() => run('/admin/build-embeddings', 'Embedding')}>
                    {unembedded === 0 ? 'Done' : 'Run'}
                  </button>
                </div>

                <div className="admin-action">
                  <div style={{ flex: 1 }}>
                    <div className="t">Ingest source directory</div>
                    <div className="d">
                      Parse, analyze and embed every file in <code>subjects/{subject}/source/</code>.
                      Re-running updates existing documents in place.
                      {unanalysed > 0 && <> Analysis of {unanalysed.toLocaleString()} chunks ≈ <span className="cost">{money(costAnalyse)}</span>.</>}
                    </div>
                  </div>
                  <button className="btn" disabled={buildRunning} onClick={() => run('/build', 'Build started')}>
                    {buildRunning ? 'Running…' : 'Run'}
                  </button>
                </div>

                <div className="admin-action">
                  <div style={{ flex: 1 }}>
                    <div className="t">Rebuild concept map</div>
                    <div className="d">
                      {current?.conceptMap === false
                        ? 'Disabled for this subject in its profile.'
                        : <>Aggregate extracted concepts into a map injected into every answer.
                            One call, ≈<span className="cost">{money(costMap)}</span>.</>}
                    </div>
                  </div>
                  <button
                    className="btn"
                    disabled={mapRunning || current?.conceptMap === false || analyzed === 0}
                    onClick={() => run('/admin/build-concept-map', 'Rebuilding concept map')}
                  >
                    {mapRunning ? 'Running…' : 'Run'}
                  </button>
                </div>

                <p style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>
                  Costs are estimates from this subject's chunk counts at published rates —
                  useful for avoiding a surprise, not for accounting.
                </p>
              </>
            )
          )}
        </div>
      </div>
    </>
  );
}
