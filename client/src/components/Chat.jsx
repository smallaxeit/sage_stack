import { useState, useRef, useEffect, useCallback } from 'react';
import Message from './Message';

/**
 * Chat, in ask_cooter's shape.
 *
 * The differences from the old SageStack chat that actually matter:
 *  - full width, not a narrow centred column: manual passages and tables need it
 *  - a textarea, not an input — Enter sends, Shift+Enter is a newline, and it
 *    grows to a cap instead of scrolling one line at a time
 *  - a Stop button, because a long streamed answer you no longer want should be
 *    abandonable without reloading
 *  - suggestions on the empty state, so a new knowledge area is not a blank box
 */

const DEFAULT_SUGGESTIONS = [
  'What is this collection about?',
  'Summarize the main themes.',
  'What topics can I ask about?',
];

/**
 * Conversation state (messages, sessionId) is OWNED BY App, not by this
 * component. Chat unmounts whenever the user switches to the Knowledge view,
 * and local state would be destroyed with it — which is exactly the bug where
 * going to Knowledge and back lost the conversation.
 */
export default function Chat({
  ready, subject, subjectName, suggestions, onOpenDoc, onOpenCite,
  messages, setMessages, sessionId, setSessionId, onSaved,
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(() => localStorage.getItem('ss-mode') || 'deep');

  const logRef = useRef(null);
  const taRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => { localStorage.setItem('ss-mode', mode); }, [mode]);

  const scrollDown = useCallback(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(scrollDown, [messages, scrollDown]);

  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(180, el.scrollHeight) + 'px';
  }

  const send = useCallback(async (text) => {
    const q = String(text ?? '').trim();
    if (!q || busy) return;

    setInput('');
    if (taRef.current) { taRef.current.style.height = 'auto'; }
    setMessages(m => [...m, { role: 'user', content: q },
      { role: 'assistant', content: '', streaming: true, stage: 'sending', startedAt: Date.now() }]);
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: q, sessionId, mode, subject }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop();

        for (const frame of frames) {
          if (!frame.startsWith('data: ')) continue;
          const ev = JSON.parse(frame.slice(6));

          if (ev.stage) {
            setMessages(m => {
              const next = [...m];
              next[next.length - 1] = { ...next[next.length - 1], stage: ev.stage };
              return next;
            });
          } else if (ev.chunk) {
            setMessages(m => {
              const next = [...m];
              const last = next[next.length - 1];
              // The first token replaces the indicator.
              next[next.length - 1] = { ...last, content: last.content + ev.chunk, stage: null };
              return next;
            });
          } else if (ev.error) {
            setMessages(m => {
              const next = [...m];
              next[next.length - 1] = {
                ...next[next.length - 1],
                content: (next[next.length - 1].content || '') + `\n\n**${ev.error}**`,
                streaming: false,
                stage: null,
              };
              return next;
            });
          } else if (ev.done) {
            setSessionId(ev.sessionId);
            onSaved?.();
            setMessages(m => {
              const next = [...m];
              next[next.length - 1] = {
                ...next[next.length - 1],
                sources: ev.sources || [],
                chips: ev.chips || [],
                streaming: false,
                stage: null,
              };
              return next;
            });
          }
        }
      }
    } catch (err) {
      const aborted = err.name === 'AbortError';
      setMessages(m => {
        const next = [...m];
        const last = next[next.length - 1];
        next[next.length - 1] = {
          ...last,
          content: last.content + (aborted ? '\n\n*(stopped)*' : `\n\n**${err.message}**`),
          streaming: false,
          stage: null,
        };
        return next;
      });
    } finally {
      setBusy(false);
      abortRef.current = null;
      setMessages(m => m.map(x => (x.streaming ? { ...x, streaming: false, stage: null } : x)));
    }
  }, [busy, sessionId, mode, subject]);

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  function newChat() {
    // Deliberately does NOT delete the current conversation — it stays in
    // history. Starting fresh and discarding are different intentions.
    setMessages([]);
    setSessionId(null);
    taRef.current?.focus();
  }

  const tips = suggestions?.length ? suggestions : DEFAULT_SUGGESTIONS;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div ref={logRef} style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        <div style={{ padding: '20px 40px 8px' }}>
          {messages.length === 0 ? (
            <div style={{ color: 'var(--muted)', textAlign: 'center', margin: '10vh auto 0', maxWidth: 560 }}>
              <h2 style={{ color: 'var(--ink)', fontSize: 19, margin: '0 0 6px' }}>
                Ask about {subjectName || 'this collection'}
              </h2>
              <div>
                {ready
                  ? 'Grounded in the loaded sources. Every answer cites the page you can open to check it.'
                  : 'This knowledge area is not searchable yet — load documents and build embeddings first.'}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginTop: 18 }}>
                {tips.map(t => (
                  <button key={t} className="chip" onClick={() => send(t)} disabled={!ready}>{t}</button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <Message
                key={i}
                role={m.role}
                content={m.content}
                sources={m.sources}
                chips={m.chips}
                streaming={m.streaming}
                stage={m.stage}
                startedAt={m.startedAt}
                onChipClick={(chip) => send(`Tell me more about: ${chip}`)}
                onOpenDoc={onOpenDoc}
                onOpenCite={onOpenCite}
              />
            ))
          )}
        </div>
      </div>

      <footer style={{ borderTop: '1px solid var(--line)', background: 'var(--panel)' }}>
        <form
          onSubmit={(e) => { e.preventDefault(); send(input); }}
          style={{ padding: '12px 40px', display: 'flex', gap: 10, alignItems: 'flex-end' }}
        >
          <textarea
            ref={taRef}
            className="ask"
            rows={1}
            value={input}
            placeholder={ready ? 'Ask a question…  (Enter to send, Shift+Enter for a new line)' : 'Not searchable yet'}
            onChange={(e) => { setInput(e.target.value); autoGrow(e.target); }}
            onKeyDown={onKeyDown}
            disabled={!ready}
            autoFocus
          />
          {busy ? (
            <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>Stop</button>
          ) : (
            <button type="submit" className="btn primary" disabled={!ready || !input.trim()}>Ask</button>
          )}
        </form>

        <div style={{ padding: '0 40px 10px', fontSize: 11.5, color: 'var(--muted)', display: 'flex', gap: 12, alignItems: 'center' }}>
          <span>Answers come from retrieved passages and cite their source page.</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              type="button"
              className={`btn icon ${mode === 'quick' ? 'active' : ''}`}
              onClick={() => setMode('quick')}
            >Quick</button>
            <button
              type="button"
              className={`btn icon ${mode === 'deep' ? 'active' : ''}`}
              onClick={() => setMode('deep')}
            >Deep</button>
            <button type="button" className="btn icon" onClick={newChat}>New chat</button>
          </span>
        </div>
      </footer>
    </div>
  );
}
