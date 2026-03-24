# SageStack

> *From scripture to social contract*

SageStack is a knowledge-driven teaching platform that guides learners through the world's great religious texts, philosophical traditions, and ethical frameworks. It doesn't just answer questions — it teaches you how to think through them.

No prior knowledge required. All learners welcome.

---

## The teaching philosophy

SageStack is built on the **Socratic method** — the oldest and most effective form of intellectual teaching, traced to Socrates in ancient Athens and practiced by great teachers across every tradition since.

Rather than lecturing, SageStack:
- **Answers directly** — no gatekeeping, no hedging. You get a real, substantive answer grounded in the source texts.
- **Then asks back** — every response ends with genuine Socratic questions designed to open the next layer of thinking and guide you toward your own conclusions.
- **Meets you where you are** — whether you're a theology student, a curious skeptic, someone raised in the faith, or someone who just wants to understand what all this is about. Ask in whatever voice comes naturally.

The goal isn't to tell you what to believe. It's to help you think more clearly about what you already believe — and what you don't.

---

## What it covers

SageStack draws from the world's major religious and philosophical traditions. The knowledge base is designed to grow.

### Currently loaded (11 sources)

**Religious texts**
| Text | Tradition |
|------|-----------|
| The Holy Bible (KJV) | Christianity |
| Ethiopian Orthodox Bible | Orthodox / Enochic Christianity |
| The Quran (ClearQuran) | Islam |
| The Book of Mormon | Latter-day Saint |
| The Gospel of Thomas | Gnostic Christianity |
| The Great Controversy — Ellen G. White | Seventh-day Adventist |

**Philosophy & Political Thought**
| Text | School |
|------|--------|
| Plato — *The Republic* | Ancient / Classical |
| John Locke — *Two Treatises of Government* | Social Contract / Natural Rights |
| John Stuart Mill — *On Liberty* | Classical Liberalism |
| Thomas Paine — *Common Sense* | American Founding / Natural Rights |
| Patrick Henry — *Give Me Liberty or Give Me Death* | American Founding |

### Staged for next build (`/source/library/`)
30+ texts ready to load — Aristotle, Aquinas, Nietzsche, Hobbes, Rousseau, Kant, Descartes, The Federalist Papers, and more. See `READING_LIST.md` for the full list.

Topics span theology, comparative religion, ethics, philosophy of religion, and the intellectual history that connects them — from the Sermon on the Mount to the social contract, from ancient Athens to the American founding.

---

## How it works

### Knowledge pipeline
Source texts are pre-processed before the app runs. Each document is:
1. Parsed and broken into contextual chunks
2. Analyzed by AI (Claude Haiku) — extracting concepts, scripture references, philosophical arguments, cross-text connections, and origin context
3. A concept map is built across all traditions (Claude Sonnet) — cross-tradition relationships, learning paths, theological parallels
4. Embedded with Voyage AI (voyage-3) for semantic vector search
5. Synced to Supabase for persistence

This happens once per source. Results are cached — adding new texts only processes new material. The reading list (`source/READING_LIST.md`) is auto-updated after each build.

### Chat
When you ask a question, the most semantically relevant passages from across all source texts are retrieved via pgvector and used to ground the response. The AI teaches strictly from the loaded texts — if it's not in the source material, it says so plainly.

### Analytics (background)
Every chat interaction is logged to Supabase — subjects, themes, which chunks were retrieved. Frequently-queried chunks are automatically flagged for deeper Sonnet re-analysis. All of this happens silently in the background and is accessible directly via the Supabase dashboard.

---

## Features

- **Streaming responses** — answers appear as they're generated, not all at once
- **Quick / Deep mode** — concise accessible answers or full scholarly treatment
- **Explore chips** — clickable concept suggestions after each response
- **Source citations** — see exactly which texts were used to generate each answer
- **Dark / Light theme** — persists across sessions
- **Admin panel** — manage builds, view source status, trigger embeddings and concept map rebuilds
- **Expandable knowledge base** — drop in new PDFs, rebuild, reading list updates automatically

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React + Vite + Tailwind CSS |
| Backend | Node.js + Express |
| Chat AI | Claude Sonnet (claude-sonnet-4-6) |
| Build AI | Claude Haiku (chunk analysis) + Claude Sonnet (concept map) |
| Embeddings | Voyage AI voyage-3 (1024-dim semantic search) |
| Database | Supabase (PostgreSQL + pgvector) |
| Search | pgvector cosine similarity → TF-IDF fallback |

---

## Setup

```bash
# Install dependencies
npm install
cd server && npm install
cd ../client && npm install

# Add your API keys
cp server/.env.example server/.env
# Edit server/.env:
#   ANTHROPIC_API_KEY=sk-ant-...
#   VOYAGE_API_KEY=pa-...
#   SUPABASE_URL=https://your-project.supabase.co
#   SUPABASE_ANON_KEY=...
#   SUPABASE_SERVICE_KEY=...
#   ADMIN_KEY=your-admin-password

# Set up the database (one-time — run in Supabase SQL Editor)
# 1. server/supabase-schema.sql
# 2. server/supabase-analytics.sql
# 3. server/supabase-vector-search.sql

# Build the knowledge base (one-time)
npm run build:knowledge

# Run the app
npm run dev    # server on :3001, client on :5199
```

Open [http://localhost:5199](http://localhost:5199)

---

## Project structure

```
/
├── client/                        # React + Vite frontend
│   └── src/
│       ├── App.jsx                # Layout, header, theme
│       └── components/
│           ├── Chat.jsx           # Chat interface + mode toggle
│           ├── Message.jsx        # Message bubbles, chips, citations
│           └── AdminPanel.jsx     # Admin slide-out panel
├── server/                        # Node/Express backend
│   ├── build-knowledge.js         # Pre-build pipeline
│   ├── rebuild-concepts.js        # Standalone concept map rebuild
│   ├── supabase-schema.sql        # Core DB schema
│   ├── supabase-analytics.sql     # Analytics tables, functions, views
│   ├── supabase-vector-search.sql # pgvector match_chunks function
│   ├── lib/
│   │   ├── claude.js              # AI integration + RAG + system prompt
│   │   ├── embeddings.js          # Voyage AI embeddings + pgvector search
│   │   ├── supabase.js            # Supabase lazy clients
│   │   ├── vectorStore.js         # Search (pgvector → TF-IDF fallback)
│   │   └── parser.js              # PDF and text parsing
│   └── routes/
│       ├── chat.js                # Chat API + session management
│       └── admin.js               # Admin API routes
├── READING_LIST.md                # Tracked source list with load status
└── source/                        # Drop source PDFs/TXTs here
```

---

## Notes

- `.env` is gitignored — never commit API keys
- `knowledge-base.json` and `knowledge-cache.json` are gitignored — **always restore cache from Supabase before rebuilding** (see build pipeline notes)
- If build crashes, restart it — cache means re-runs only process new chunks, never from scratch
- Source PDFs are gitignored — store separately (books.google.com for public domain texts)
- Sessions persist in Supabase — survive server restarts
- Analytics log silently to Supabase — query via dashboard when needed
