import { useState, useEffect, useRef, useCallback } from 'react';
import Chat from './components/Chat';
import AdminPanel from './components/AdminPanel';

const THEMES = ['dark', 'light'];
const THEME_ICONS = { dark: '🌙', light: '☀️' };
const THEME_LABELS = { dark: 'Dark', light: 'Light' };

export default function App() {
  const [status, setStatus] = useState(null);
  const [buildProgress, setBuildProgress] = useState(null);
  const [building, setBuilding] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('ss-theme') || 'dark');
  const [adminOpen, setAdminOpen] = useState(false);
  const pollRef = useRef(null);

  // Apply theme to root
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ss-theme', theme);
  }, [theme]);

  function cycleTheme() {
    setTheme(t => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]);
  }

  useEffect(() => {
    fetch('/api/status')
      .then(r => r.json())
      .then(setStatus)
      .catch(() => setStatus({ ready: false }));
  }, []);

  const startBuild = useCallback(() => {
    setBuilding(true);
    fetch('/api/build', { method: 'POST' })
      .then(r => r.json())
      .then(() => {
        clearTimeout(pollRef.current);
        pollRef.current = setTimeout(poll, 1000);
      })
      .catch(() => setBuilding(false));
  }, []);

  useEffect(() => {
    function poll() {
      fetch('/api/build-progress')
        .then(r => r.json())
        .then(p => {
          setBuildProgress(p);
          const active = p.status === 'running' || p.status === 'starting';
          setBuilding(active);
          if (p.status === 'done') {
            fetch('/api/status').then(r => r.json()).then(setStatus).catch(() => {});
          }
          // Always keep polling — fast when building, slow when idle
          pollRef.current = setTimeout(poll, active ? 3000 : 8000);
        })
        .catch(() => { pollRef.current = setTimeout(poll, 8000); });
    }
    poll();
    return () => clearTimeout(pollRef.current);
  }, []);

  const ready = status?.ready ?? false;

  return (
    <div className="flex flex-col h-svh max-w-3xl mx-auto w-full">
      {/* Header — always dark regardless of theme */}
      <header className="px-6 py-4 shrink-0" style={{ borderBottom: '1px solid var(--header-border)', background: 'var(--header-bg)' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/avatar.png" alt="Sage" className="w-10 h-10 rounded-full object-cover shadow-lg" style={{ border: '1px solid var(--header-icon-border)' }} />
            <div>
              <h1 className="text-base font-semibold leading-none" style={{ color: 'var(--header-text)' }}>SageStack</h1>
              <p className="text-xs mt-0.5" style={{ color: 'var(--header-subtext)' }}>from scripture to social contract</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${ready ? 'bg-emerald-500' : 'bg-slate-500'}`} />
            </div>
            {/* Theme toggle */}
            <button
              onClick={cycleTheme}
              title={`Switch theme (${THEME_LABELS[theme]})`}
              className="text-sm px-2 py-1 rounded-lg transition-colors"
              style={{ border: '1px solid var(--header-icon-border)', color: 'var(--header-meta)' }}
            >
              {THEME_ICONS[theme]}
            </button>
            <button
              onClick={() => setAdminOpen(true)}
              title="Admin panel"
              className="text-xs px-2.5 py-1 rounded-lg transition-colors"
              style={{ border: '1px solid var(--header-icon-border)', color: 'var(--header-meta)' }}
            >
              ⚙
            </button>
          </div>
        </div>

        {/* Build progress bar */}
        {(buildProgress?.status === 'running' || buildProgress?.status === 'starting') && (
          <div className="mt-3">
            <div className="flex justify-between text-xs mb-1" style={{ color: '#7d8590' }}>
              <span>
                {buildProgress.phase === 'concept-map'
                  ? 'Building concept map…'
                  : buildProgress.phase === 'embeddings'
                  ? `Embedding — ${buildProgress.current?.toLocaleString()} / ${buildProgress.total?.toLocaleString()}`
                  : `Analyzing sources — ${buildProgress.current?.toLocaleString()} / ${buildProgress.total?.toLocaleString()} chunks`}
              </span>
              <span>
                {buildProgress.pct}%
                {buildProgress.remainingMins > 0 ? ` · ~${
                  buildProgress.remainingMins >= 60
                    ? `${Math.floor(buildProgress.remainingMins / 60)}h ${buildProgress.remainingMins % 60}m`
                    : `${buildProgress.remainingMins}m`
                } left` : ''}
              </span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--progress-track)' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${buildProgress.pct || 0}%`, background: 'var(--progress-fill)' }}
              />
            </div>
          </div>
        )}
        {buildProgress?.status === 'done' && (
          <div className="mt-2 text-xs" style={{ color: '#3fb950' }}>
            ✓ Knowledge base updated — {buildProgress.concepts ?? 0} concepts across {buildProgress.sources ?? 0} sources
          </div>
        )}
        {buildProgress?.status === 'error' && (
          <div className="mt-2 text-xs" style={{ color: '#f87171' }}>
            ✕ Build failed: {buildProgress.message}
          </div>
        )}

      </header>

      {/* Chat */}
      <main className="flex-1 overflow-hidden">
        <Chat ready={ready} />
      </main>

      {/* Admin panel */}
      <AdminPanel
        open={adminOpen}
        onClose={() => setAdminOpen(false)}
        buildProgress={buildProgress}
      />
    </div>
  );
}
