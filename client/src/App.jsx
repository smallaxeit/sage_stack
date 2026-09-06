import { useState, useEffect, useRef, useCallback } from 'react';
import Chat from './components/Chat';
import KnowledgePanel from './components/KnowledgePanel';
import PageViewer from './components/PageViewer';
import AdminPanel from './components/AdminPanel';

/**
 * Shell, in ask_cooter's layout: a thin header, a collapsible left sidebar, and
 * the working area filling everything else.
 *
 * The sidebar lists knowledge areas rather than chat history, because subjects
 * are tenants here — switching one is the most consequential thing you can do,
 * so it belongs somewhere permanent rather than behind a menu.
 */

export default function App() {
  const [status, setStatus] = useState(null);
  const [subject, setSubject] = useState(() => localStorage.getItem('ss-subject') || null);
  const [view, setView] = useState('chat');
  const [openDoc, setOpenDoc] = useState(null);
  const [sidebar, setSidebar] = useState(() => localStorage.getItem('ss-sidebar') !== 'closed');
  const [adminOpen, setAdminOpen] = useState(false);

  // Conversation state lives here so switching to Knowledge and back does not
  // destroy it — Chat unmounts on that switch.
  const [messages, setMessages] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [theme, setTheme] = useState(() => localStorage.getItem('ss-theme') || 'dark');
  const [docs, setDocs] = useState([]);
  const pollRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ss-theme', theme);
  }, [theme]);

  useEffect(() => { if (subject) localStorage.setItem('ss-subject', subject); }, [subject]);
  useEffect(() => { localStorage.setItem('ss-sidebar', sidebar ? 'open' : 'closed'); }, [sidebar]);

  const refreshStatus = useCallback(() => {
    const url = subject ? `/api/status?subject=${encodeURIComponent(subject)}` : '/api/status';
    return fetch(url)
      .then(r => r.json())
      .then(s => {
        setStatus(s);
        if (!subject && s.subjects?.length) setSubject(s.subjects[0].slug);
        return s;
      })
      .catch(() => setStatus({ ready: false, subjects: [] }));
  }, [subject]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  // Documents drive both the sidebar counts and the citation viewer's fallback.
  const refreshDocs = useCallback(() => {
    if (!subject) return;
    fetch(`/api/documents/${subject}`)
      .then(r => r.json())
      .then(d => setDocs(d.documents || []))
      .catch(() => setDocs([]));
  }, [subject]);

  useEffect(() => { refreshDocs(); }, [refreshDocs]);

  const refreshSessions = useCallback(() => {
    if (!subject) return;
    fetch(`/api/sessions?subject=${encodeURIComponent(subject)}`)
      .then(r => r.json())
      .then(d => setSessions(d.sessions || []))
      .catch(() => setSessions([]));
  }, [subject]);

  useEffect(() => { refreshSessions(); }, [refreshSessions]);

  // A conversation belongs to one subject, so switching clears the open one.
  useEffect(() => { setMessages([]); setSessionId(null); }, [subject]);

  /** Reopen a stored conversation. Costs nothing — the messages are saved. */
  const openSession = useCallback(async (id) => {
    try {
      const d = await fetch(
        `/api/sessions/${encodeURIComponent(id)}?subject=${encodeURIComponent(subject)}`,
      ).then(r => r.json());
      if (d.messages) {
        setMessages(d.messages);
        setSessionId(id);
        setView('chat');
      }
    } catch { /* gone; the list will catch up on the next refresh */ }
  }, [subject]);

  const deleteSession = useCallback(async (id, e) => {
    e.stopPropagation();
    await fetch(
      `/api/sessions/${encodeURIComponent(id)}?subject=${encodeURIComponent(subject)}`,
      { method: 'DELETE' },
    ).catch(() => {});
    if (id === sessionId) { setMessages([]); setSessionId(null); }
    refreshSessions();
  }, [subject, sessionId, refreshSessions]);

  useEffect(() => {
    function poll() {
      fetch('/api/build-progress')
        .then(r => r.json())
        .then(p => {
          if (p.status === 'running' || p.status === 'starting') pollRef.current = setTimeout(poll, 3000);
          else if (p.status === 'done') { refreshStatus(); refreshDocs(); }
        })
        .catch(() => {});
    }
    poll();
    return () => clearTimeout(pollRef.current);
  }, [refreshStatus, refreshDocs]);

  const subjects = status?.subjects || [];
  const current = subjects.find(s => s.slug === subject);
  const ready = current?.ready ?? false;

  /**
   * An inline [p.N] citation names a page but not a document. With one source
   * loaded that is unambiguous; with several, the largest is the best guess and
   * the reader can switch documents in the viewer.
   */
  const openCitation = useCallback((page) => {
    // "Viewable" means the page can be SHOWN — either a local PDF, or page
    // scans served from the store. Gating on a local file alone broke citations
    // for any corpus connected in place, which has scans but no PDF.
    const doc = docs.find(d => d.viewable) || docs.find(d => d.hasFile);
    if (!doc) return;
    setOpenDoc({ filename: doc.filename, title: doc.filename, page });
  }, [docs]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100svh' }}>
      <header style={{
        padding: '10px 16px', borderBottom: '1px solid var(--line)', background: 'var(--panel)',
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flexShrink: 0,
      }}>
        <button className="btn icon" onClick={() => setSidebar(s => !s)} title="Knowledge areas">☰</button>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, marginRight: 'auto', minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: 17, letterSpacing: '.2px' }}>
            {current?.name || 'SageStack'}
          </h1>
          <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>
            {current
              ? (current.ready
                  ? `${current.chunks.toLocaleString()} chunks · ${current.embedModel || 'model unknown'}`
                  : current.chunks > 0
                    ? `${current.chunks.toLocaleString()} chunks — not embedded`
                    : 'nothing loaded')
              : 'from scripture to social contract'}
          </span>
        </div>

        <button
          className={`btn ${view === 'chat' ? 'active' : ''}`}
          onClick={() => setView('chat')}
        >Chat</button>
        <button
          className={`btn ${view === 'knowledge' ? 'active' : ''}`}
          onClick={() => setView('knowledge')}
        >Knowledge</button>
        <button
          className="btn icon"
          onClick={() => setAdminOpen(true)}
          title="Admin"
        >⚙</button>
        <button
          className="btn icon"
          onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
          title="Toggle theme"
        >◐</button>
      </header>

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {sidebar && (
          <aside style={{
            width: 250, flex: 'none', borderRight: '1px solid var(--line)',
            background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 0,
          }}>
            <div className="side-head"><span>Knowledge areas</span></div>
            <div style={{ overflowY: 'auto', padding: '4px 8px 12px' }}>
              {subjects.length === 0 && (
                <p style={{ color: 'var(--muted)', fontSize: 12.5, padding: '8px 10px' }}>
                  No subjects defined.
                </p>
              )}
              {subjects.map(s => (
                <button
                  key={s.slug}
                  className={`hist ${s.slug === subject ? 'active' : ''}`}
                  onClick={() => { setSubject(s.slug); setOpenDoc(null); }}
                  title={s.storeError || `${s.chunks} chunks via ${s.storeDriver}`}
                  style={{ whiteSpace: 'normal' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{
                      width: 7, height: 7, borderRadius: 999, flexShrink: 0,
                      background: s.ready ? '#3fb950' : s.chunks > 0 ? '#d29922' : 'var(--muted)',
                    }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', paddingLeft: 13 }}>
                    {s.chunks > 0 ? `${s.chunks.toLocaleString()} chunks` : 'empty'}
                    {s.readOnly ? ' · read-only' : ''}
                  </div>
                </button>
              ))}
            </div>

            {sessions.length > 0 && (
              <>
                <div className="side-head" style={{ paddingTop: 14 }}>
                  <span>Conversations</span>
                  <button
                    className="btn icon"
                    style={{ fontSize: 11, padding: '2px 7px' }}
                    onClick={() => { setMessages([]); setSessionId(null); setView('chat'); }}
                  >New</button>
                </div>
                <div style={{ overflowY: 'auto', padding: '2px 8px 10px', maxHeight: '38vh' }}>
                  {sessions.map(sess => (
                    <button
                      key={sess.id}
                      className={`hist ${sess.id === sessionId ? 'active' : ''}`}
                      onClick={() => openSession(sess.id)}
                      title={sess.title}
                      style={{ whiteSpace: 'normal', position: 'relative', paddingRight: 22 }}
                    >
                      <span style={{
                        display: 'block', overflow: 'hidden', textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>{sess.title}</span>
                      <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                        {sess.messageCount} message{sess.messageCount === 1 ? '' : 's'}
                      </span>
                      <span
                        onClick={(e) => deleteSession(sess.id, e)}
                        title="Delete conversation"
                        style={{
                          position: 'absolute', right: 4, top: 6, fontSize: 12,
                          color: 'var(--muted)', padding: '0 4px', cursor: 'pointer',
                        }}
                      >×</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            {status?.errors?.length > 0 && (
              <div style={{ padding: '8px 12px', borderTop: '1px solid var(--line)', fontSize: 11.5, color: '#d29922' }}>
                {status.errors.map(e => <div key={e.slug}>⚠ {e.slug}: {e.error}</div>)}
              </div>
            )}

            <div style={{ marginTop: 'auto', padding: '10px 12px', borderTop: '1px solid var(--line)', fontSize: 11.5, color: 'var(--muted)' }}>
              store: {status?.store || '—'}
            </div>
          </aside>
        )}

        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {view === 'chat' ? (
            <Chat
              ready={ready}
              subject={subject}
              subjectName={current?.name}
              onOpenDoc={setOpenDoc}
              onOpenCite={openCitation}
              messages={messages}
              setMessages={setMessages}
              sessionId={sessionId}
              setSessionId={setSessionId}
              onSaved={refreshSessions}
            />
          ) : (
            <KnowledgePanel
              subject={subject}
              current={current}
              docs={docs}
              onRefresh={() => { refreshStatus(); refreshDocs(); }}
              onOpenDoc={setOpenDoc}
            />
          )}
        </main>
      </div>

      <PageViewer subject={subject} doc={openDoc} onClose={() => setOpenDoc(null)} />

      <AdminPanel
        open={adminOpen}
        onClose={() => setAdminOpen(false)}
        subject={subject}
        current={current}
        docs={docs}
        onRefresh={() => { refreshStatus(); refreshDocs(); }}
      />
    </div>
  );
}
