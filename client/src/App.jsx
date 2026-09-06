import { useState, useEffect, useRef, useCallback } from 'react';
import Chat from './components/Chat';
import AdminPanel from './components/AdminPanel';
import KnowledgePanel from './components/KnowledgePanel';
import PageViewer from './components/PageViewer';

const THEMES = ['dark', 'light'];
const THEME_ICONS = { dark: '🌙', light: '☀️' };
const THEME_LABELS = { dark: 'Dark', light: 'Light' };

export default function App() {
  const [status, setStatus] = useState(null);
  const [subject, setSubject] = useState(() => localStorage.getItem('ss-subject') || null);
  const [view, setView] = useState('chat');            // 'chat' | 'knowledge'
  const [openDoc, setOpenDoc] = useState(null);        // { filename, page, printedPage, excerpt }
  const [buildProgress, setBuildProgress] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('ss-theme') || 'dark');
  const [adminOpen, setAdminOpen] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ss-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (subject) localStorage.setItem('ss-subject', subject);
  }, [subject]);

  function cycleTheme() {
    setTheme(t => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]);
  }

  const refreshStatus = useCallback(() => {
    const url = subject ? `/api/status?subject=${encodeURIComponent(subject)}` : '/api/status';
    return fetch(url)
      .then(r => r.json())
      .then(s => {
        setStatus(s);
        // Adopt a subject on first load so every later call is explicitly scoped.
        if (!subject && s.subjects?.length) setSubject(s.subjects[0].slug);
        return s;
      })
      .catch(() => setStatus({ ready: false, subjects: [] }));
  }, [subject]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  useEffect(() => {
    function poll() {
      fetch('/api/build-progress')
        .then(r => r.json())
        .then(p => {
          setBuildProgress(p);
          if (p.status === 'running' || p.status === 'starting') {
            pollRef.current = setTimeout(poll, 3000);
          } else if (p.status === 'done') {
            refreshStatus();
          }
        })
        .catch(() => {});
    }
    poll();
    return () => clearTimeout(pollRef.current);
  }, [refreshStatus]);

  const subjects = status?.subjects || [];
  const current = subjects.find(s => s.slug === subject);
  const ready = current?.ready ?? status?.ready ?? false;
  const wide = view === 'knowledge';

  return (
    <div className={`flex flex-col h-svh mx-auto w-full ${wide ? 'max-w-5xl' : 'max-w-3xl'}`}>
      <header className="px-6 py-4 shrink-0" style={{ borderBottom: '1px solid var(--header-border)', background: 'var(--header-bg)' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/avatar.png" alt="Sage" className="w-10 h-10 rounded-full object-cover shadow-lg" style={{ border: '1px solid var(--header-icon-border)' }} />
            <div className="min-w-0">
              <h1 className="text-base font-semibold leading-none truncate" style={{ color: 'var(--header-text)' }}>
                {current?.name || 'SageStack'}
              </h1>
              <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--header-subtext)' }}>
                {current
                  ? (current.ready
                      ? `${current.chunks.toLocaleString()} chunks · ${current.embedModel || 'no model recorded'}`
                      : current.chunks > 0
                        ? `${current.chunks.toLocaleString()} chunks — not embedded, so not searchable`
                        : 'no knowledge loaded yet')
                  : 'from scripture to social contract'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className={`w-2 h-2 rounded-full ${ready ? 'bg-emerald-500' : 'bg-slate-500'}`} />

            <button
              onClick={() => setView(v => (v === 'chat' ? 'knowledge' : 'chat'))}
              className="text-xs px-2.5 py-1 rounded-lg transition-colors"
              style={{ border: '1px solid var(--header-icon-border)', color: 'var(--header-meta)' }}
            >
              {view === 'chat' ? '📚 Knowledge' : '💬 Chat'}
            </button>

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
              <div className="h-full rounded-full transition-all duration-500"
                style={{ width: `${buildProgress.pct || 0}%`, background: 'var(--progress-fill)' }} />
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 overflow-hidden">
        {view === 'chat' ? (
          <Chat
            ready={ready}
            subject={subject}
            onOpenDoc={setOpenDoc}
          />
        ) : (
          <KnowledgePanel
            subject={subject}
            subjects={subjects}
            onSubjectChange={(s) => { setSubject(s); setOpenDoc(null); }}
            onOpenDoc={setOpenDoc}
          />
        )}
      </main>

      <PageViewer subject={subject} doc={openDoc} onClose={() => setOpenDoc(null)} />

      <AdminPanel
        open={adminOpen}
        onClose={() => setAdminOpen(false)}
        buildProgress={buildProgress}
        subject={subject}
      />
    </div>
  );
}
