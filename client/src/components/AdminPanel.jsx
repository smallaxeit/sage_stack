import { useState, useEffect, useCallback } from 'react';

const ADMIN_KEY = 'sagestack-admin-2026';

function api(path, opts = {}) {
  return fetch(`/api/admin${path}`, {
    ...opts,
    headers: { 'x-admin-key': ADMIN_KEY, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  }).then(r => r.json());
}

function Stat({ label, value, sub }) {
  return (
    <div className="admin-stat">
      <div className="admin-stat-value">{value ?? '—'}</div>
      <div className="admin-stat-label">{label}</div>
      {sub && <div className="admin-stat-sub">{sub}</div>}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="admin-section">
      <h3 className="admin-section-title">{title}</h3>
      {children}
    </div>
  );
}

export default function AdminPanel({ open, onClose, buildProgress }) {
  const [stats, setStats]       = useState(null);
  const [sources, setSources]   = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [tab, setTab]           = useState('status');
  const [actionMsg, setActionMsg] = useState('');

  const load = useCallback(() => {
    if (!open) return;
    api('/stats').then(setStats).catch(() => {});
    api('/sources').then(setSources).catch(() => {});
    api('/analytics').then(setAnalytics).catch(() => {});
  }, [open]);

  useEffect(() => { load(); }, [load]);

  async function triggerAction(endpoint, label) {
    setActionMsg(`${label}…`);
    try {
      const res = await api(endpoint, { method: 'POST' });
      setActionMsg(res.message || 'Started');
    } catch {
      setActionMsg('Error starting task');
    }
    setTimeout(() => setActionMsg(''), 4000);
  }

  const embPct = stats ? Math.round((stats.embeddings / stats.chunks) * 100) : 0;
  const isBuilding = buildProgress?.status === 'running' || buildProgress?.status === 'starting';

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="admin-backdrop" onClick={onClose} />

      {/* Panel */}
      <div className="admin-panel">
        <div className="admin-header">
          <span className="admin-title">⚙ Admin</span>
          <button className="admin-close" onClick={onClose}>✕</button>
        </div>

        {/* Tabs */}
        <div className="admin-tabs">
          {['status', 'sources', 'analytics', 'actions'].map(t => (
            <button key={t} className={`admin-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <div className="admin-body">

          {/* STATUS TAB */}
          {tab === 'status' && (
            <>
              <Section title="Knowledge Base">
                <div className="admin-stats-grid">
                  <Stat label="Chunks" value={stats?.chunks?.toLocaleString()} />
                  <Stat label="Concepts" value={stats?.concepts?.toLocaleString()} />
                  <Stat label="Traditions" value={stats?.traditions} />
                  <Stat label="Sources" value={stats?.sources?.length} />
                </div>
                {stats?.builtAt && (
                  <p className="admin-meta">Last built: {new Date(stats.builtAt).toLocaleString()}</p>
                )}
              </Section>

              <Section title="Embeddings (Voyage AI)">
                <div className="admin-progress-row">
                  <span>{stats?.embeddings?.toLocaleString() || 0} / {stats?.chunks?.toLocaleString() || 0}</span>
                  <span>{embPct}%</span>
                </div>
                <div className="admin-bar-track">
                  <div className="admin-bar-fill" style={{ width: `${embPct}%` }} />
                </div>
              </Section>

              <Section title="Usage">
                <div className="admin-stats-grid">
                  <Stat label="Sessions" value={stats?.sessions?.toLocaleString()} />
                  <Stat label="Chat Logs" value={stats?.chatLogs?.toLocaleString()} />
                  <Stat label="Sonnet Queue" value={stats?.sonnetQueued} sub="chunks for upgrade" />
                </div>
              </Section>

              {isBuilding && (
                <Section title="Build Running">
                  <div className="admin-progress-row">
                    <span>{buildProgress.phase === 'concept-map' ? 'Building concept map…' : `${buildProgress.current?.toLocaleString()} / ${buildProgress.total?.toLocaleString()} chunks`}</span>
                    <span>{buildProgress.pct}%</span>
                  </div>
                  <div className="admin-bar-track">
                    <div className="admin-bar-fill" style={{ width: `${buildProgress.pct || 0}%` }} />
                  </div>
                  {buildProgress.remainingMins > 0 && (
                    <p className="admin-meta">
                      ~{buildProgress.remainingMins >= 60
                        ? `${Math.floor(buildProgress.remainingMins / 60)}h ${buildProgress.remainingMins % 60}m`
                        : `${buildProgress.remainingMins}m`} remaining
                    </p>
                  )}
                </Section>
              )}
            </>
          )}

          {/* SOURCES TAB */}
          {tab === 'sources' && (
            <Section title="Source Files">
              {sources.length === 0
                ? <p className="admin-empty">No sources loaded</p>
                : sources.map(s => (
                  <div key={s.source} className="admin-source-row">
                    <div className="admin-source-name">{s.source.replace('.pdf', '')}</div>
                    <div className="admin-source-meta">
                      <span>{s.total.toLocaleString()} chunks</span>
                      <span className={s.analyzed === s.total ? 'text-emerald-400' : 'text-amber-400'}>
                        {s.analyzed.toLocaleString()} analyzed
                      </span>
                      <span className={s.withEmbedding === s.total ? 'text-emerald-400' : 'text-slate-400'}>
                        {s.withEmbedding.toLocaleString()} embedded
                      </span>
                    </div>
                    <div className="admin-source-bar-track">
                      <div className="admin-source-bar-analyzed" style={{ width: `${Math.round(s.analyzed / s.total * 100)}%` }} />
                    </div>
                  </div>
                ))
              }
            </Section>
          )}

          {/* ANALYTICS TAB */}
          {tab === 'analytics' && (
            <>
              <Section title="Top Subjects Asked">
                {!analytics?.subjects?.length
                  ? <p className="admin-empty">No data yet — start chatting</p>
                  : analytics.subjects.map((s, i) => (
                    <div key={i} className="admin-analytics-row">
                      <span className="admin-analytics-label">{s.subject?.replace(/"/g, '')}</span>
                      <span className="admin-analytics-count">{s.query_count}</span>
                    </div>
                  ))
                }
              </Section>
              <Section title="Most Retrieved Chunks">
                {!analytics?.hotChunks?.length
                  ? <p className="admin-empty">No data yet</p>
                  : analytics.hotChunks.slice(0, 10).map((c, i) => (
                    <div key={i} className="admin-analytics-row">
                      <span className="admin-analytics-label">{c.source?.replace('.pdf', '')} #{c.chunk_index}</span>
                      <div className="flex items-center gap-2">
                        {c.sonnet_queued && !c.sonnet_done && <span className="admin-badge amber">queued</span>}
                        {c.sonnet_done && <span className="admin-badge green">upgraded</span>}
                        <span className="admin-analytics-count">{c.query_count}×</span>
                      </div>
                    </div>
                  ))
                }
              </Section>
              <Section title="Recent Questions">
                {!analytics?.recentLogs?.length
                  ? <p className="admin-empty">No logs yet</p>
                  : analytics.recentLogs.map((l, i) => (
                    <div key={i} className="admin-log-row">
                      <div className="admin-log-msg">{l.user_message?.slice(0, 100)}</div>
                      <div className="admin-log-meta">
                        <span className="admin-badge slate">{l.mode}</span>
                        <span>{new Date(l.created_at).toLocaleString()}</span>
                      </div>
                    </div>
                  ))
                }
              </Section>
            </>
          )}

          {/* ACTIONS TAB */}
          {tab === 'actions' && (
            <Section title="Pipeline Actions">
              {actionMsg && <div className="admin-action-msg">{actionMsg}</div>}

              <div className="admin-actions-list">
                <div className="admin-action-item">
                  <div>
                    <div className="admin-action-title">Build Embeddings</div>
                    <div className="admin-action-desc">Generate Voyage AI embeddings for all unembedded chunks. ~$0.04 one-time cost.</div>
                  </div>
                  <button className="admin-btn blue" onClick={() => triggerAction('/build-embeddings', 'Building embeddings')}>
                    Run
                  </button>
                </div>

                <div className="admin-action-item">
                  <div>
                    <div className="admin-action-title">Rebuild Concept Map</div>
                    <div className="admin-action-desc">Re-analyze cross-tradition relationships with Claude Sonnet. ~$1–2.</div>
                  </div>
                  <button className="admin-btn blue" onClick={() => triggerAction('/build-concept-map', 'Rebuilding concept map')}>
                    Run
                  </button>
                </div>

                <div className="admin-action-item">
                  <div>
                    <div className="admin-action-title">Full Knowledge Rebuild</div>
                    <div className="admin-action-desc">Re-analyze all chunks + concept map. Use when new source files are added.</div>
                  </div>
                  <button className="admin-btn amber" disabled={isBuilding} onClick={() => triggerAction('/build', 'Full rebuild started')}>
                    {isBuilding ? 'Running…' : 'Run'}
                  </button>
                </div>
              </div>
            </Section>
          )}

        </div>
      </div>
    </>
  );
}
