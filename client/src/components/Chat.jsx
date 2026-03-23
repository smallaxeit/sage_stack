import { useState, useRef, useEffect } from 'react';
import Message from './Message';

const WELCOME = {
  role: 'assistant',
  content: "Grace and peace to you, friend. 🙏\n\nWhat's on your mind today? Is there a passage, a concept, or a question about the faith you'd like to explore?",
};

export default function Chat({ ready }) {
  const [messages, setMessages] = useState([WELCOME]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [mode, setMode] = useState('quick');
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const scrollRef = useRef(null);
  const isStreamingRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 120) {
      bottomRef.current?.scrollIntoView({ behavior: isStreamingRef.current ? 'instant' : 'smooth' });
    }
  }, [messages, loading]);

  async function send(overrideText) {
    const text = (overrideText || input).trim();
    if (!text || loading || !ready) return;

    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setLoading(true);
    isStreamingRef.current = false;

    setMessages(prev => [...prev, { role: 'assistant', content: '' }]);
    isStreamingRef.current = true;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId, mode }),
      });

      if (!res.ok) throw new Error('Request failed');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = JSON.parse(line.slice(6));

          if (data.chunk) {
            setMessages(prev => {
              const msgs = [...prev];
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                content: msgs[msgs.length - 1].content + data.chunk,
              };
              return msgs;
            });
          } else if (data.done) {
            setSessionId(data.sessionId);
            setMessages(prev => {
              const msgs = [...prev];
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                sources: data.sources || [],
                chips: data.chips || [],
              };
              return msgs;
            });
          } else if (data.error) {
            throw new Error(data.error);
          }
        }
      }
    } catch (err) {
      const fallback = "Sage is on retreat. The scrolls will be available again shortly.";
      setMessages(prev => {
        const msgs = [...prev];
        msgs[msgs.length - 1] = { role: 'assistant', content: fallback };
        return msgs;
      });
    } finally {
      isStreamingRef.current = false;
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  async function reset() {
    if (sessionId) {
      await fetch(`/api/chat/${sessionId}`, { method: 'DELETE' });
    }
    setSessionId(null);
    setMessages([WELCOME]);
    setInput('');
    inputRef.current?.focus();
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
        {messages.map((msg, i) => (
          <Message
            key={i}
            role={msg.role}
            content={msg.content}
            sources={msg.sources}
            chips={msg.chips}
            onChipClick={(chip) => send(`Tell me more about: ${chip}`)}
          />
        ))}

        {loading && (
          <div className="flex justify-start mb-4">
            <div className="w-8 h-8 rounded-full bg-blue-950 border border-blue-700/40 flex items-center justify-center text-sm font-bold text-blue-300 mr-3 mt-1 shrink-0">
              T
            </div>
            <div className="bg-stone-800 border border-stone-700 px-4 py-3 rounded-2xl rounded-bl-sm">
              <span className="flex gap-1 items-center h-5">
                <span className="w-2 h-2 bg-yellow-600 rounded-full animate-bounce [animation-delay:0ms]" />
                <span className="w-2 h-2 bg-yellow-600 rounded-full animate-bounce [animation-delay:150ms]" />
                <span className="w-2 h-2 bg-yellow-600 rounded-full animate-bounce [animation-delay:300ms]" />
              </span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-4" style={{ borderTop: '1px solid var(--border)' }}>
        {!ready && (
          <p className="text-center text-sm text-slate-400 mb-3">
            Knowledge base not ready. Run <code className="bg-blue-950/60 px-1 rounded text-blue-300">npm run build:knowledge</code> first.
          </p>
        )}

        {/* Mode toggle */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs" style={{ color: 'var(--toggle-inactive-text)' }}>Depth:</span>
          <button
            onClick={() => setMode('quick')}
            className="text-xs px-2.5 py-1 rounded-lg border transition-colors"
            style={mode === 'quick'
              ? { background: 'var(--toggle-active-bg)', border: '1px solid var(--toggle-active-border)', color: 'var(--toggle-active-text)' }
              : { background: 'transparent', border: '1px solid transparent', color: 'var(--toggle-inactive-text)' }
            }
          >
            ⚡ Quick
          </button>
          <button
            onClick={() => setMode('deep')}
            className="text-xs px-2.5 py-1 rounded-lg border transition-colors"
            style={mode === 'deep'
              ? { background: 'var(--toggle-active-bg)', border: '1px solid var(--toggle-active-border)', color: 'var(--toggle-active-text)' }
              : { background: 'transparent', border: '1px solid transparent', color: 'var(--toggle-inactive-text)' }
            }
          >
            🔬 Deep
          </button>
        </div>

        <div className="flex gap-3 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            disabled={!ready || loading}
            placeholder={ready ? 'Ask a question or share a thought…' : 'Waiting for knowledge base…'}
            rows={1}
            className="flex-1 resize-none rounded-xl px-4 py-3 text-sm focus:outline-none disabled:opacity-50 max-h-32 overflow-y-auto"
            style={{
              background: 'var(--input-bg)',
              border: '1px solid var(--input-border)',
              color: 'var(--text-primary)',
              fieldSizing: 'content',
            }}
          />
          <button
            onClick={() => send()}
            disabled={!ready || loading || !input.trim()}
            className="disabled:opacity-40 disabled:cursor-not-allowed font-medium rounded-xl px-4 py-3 text-sm transition-colors"
            style={{ background: 'var(--avatar-bg)', color: 'var(--text-primary)', border: '1px solid var(--input-border)' }}
          >
            Send
          </button>
          <button
            onClick={reset}
            title="New session"
            className="rounded-xl px-3 py-3 text-sm transition-colors"
            style={{ background: 'var(--avatar-bg)', color: 'var(--text-secondary)', border: '1px solid var(--input-border)' }}
          >
            ↺
          </button>
        </div>
        <p className="text-xs mt-2 text-center" style={{ color: 'var(--text-muted)' }}>Press Enter to send · Shift+Enter for new line</p>
      </div>
    </div>
  );
}
