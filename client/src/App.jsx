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
          if (p.status === 'running' || p.status === 'starting') {
            setBuilding(true);
            pollRef.current = setTimeout(poll, 3000);
          } else if (p.status === 'done') {
            setBuilding(false);
            fetch('/api/status').then(r => r.json()).then(setStatus).catch(() => {});
          }
        })
        .catch(() => {});
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
            <div className="w-10 h-10 rounded-full flex items-center justify-center text-xl select-none shadow-lg" style={{ background: 'var(--header-icon-bg)', border: '1px solid var(--header-icon-border)', color: 'var(--header-icon-color)' }}>
              ✝
            </div>
            <div>
              <h1 className="text-base font-semibold leading-none" style={{ color: 'var(--header-text)' }}>SageStack</h1>
              <p className="text-xs mt-0.5" style={{ color: 'var(--header-subtext)' }}>from scripture to social contract</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${ready ? 'bg-emerald-500' : 'bg-slate-500'}`} />
              <span className="text-xs" style={{ color: 'var(--header-meta)' }}>
                {ready
                  ? `${status.chunks.toLocaleString()} chunks · ${status.concepts} concepts`
                  : 'Knowledge base not built'}
              </span>
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

        {/* Core themes strip */}
        {ready && status.coreThemes?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {status.coreThemes.map(t => (
              <span
                key={t}
                className="text-xs px-2 py-0.5 rounded-full"
                style={{ background: 'var(--chip-bg)', color: 'var(--chip-text)', border: '1px solid var(--chip-border)' }}
              >
                {t}
              </span>
            ))}
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
