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

SageStack draws from across the world's major religious and philosophical traditions:

| Text | Tradition |
|------|-----------|
| The Holy Bible (KJV) | Christianity |
| Ethiopian Orthodox Bible | Orthodox Christianity |
| Torah | Judaism |
| Quran | Islam |
| The 4 Vedas | Hinduism |
| Buddhist texts | Buddhism |

Topics span theology, comparative religion, ethics, philosophy of religion, and the intellectual history that connects them — from the Sermon on the Mount to the social contract, from dharma to divine command theory.

---

## How it works

### Knowledge pipeline
Source texts are pre-processed before the app runs. Each document is:
1. Parsed and broken into contextual chunks
2. Deeply analyzed by AI — extracting concepts, scripture references, philosophical arguments, cross-text connections, and origin context
3. Indexed for fast semantic search

This happens once. Results are cached permanently — adding new texts only processes the new material.

### Chat
When you ask a question, the most relevant passages from across all source texts are retrieved and used to ground the response. The AI teaches strictly from the loaded texts — if it's not in the source material, it says so plainly.

---

## Features

- **Streaming responses** — answers appear as they're generated, not all at once
- **Quick / Deep mode** — concise accessible answers or full scholarly treatment
- **Explore chips** — clickable concept suggestions after each response to keep the inquiry going
- **Source citations** — see exactly which texts were used to generate each answer
- **Dark / Light theme** — persists across sessions
- **Expandable knowledge base** — drop in new PDFs and rebuild anytime

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React + Vite + Tailwind CSS |
| Backend | Node.js + Express |
| AI | Claude Sonnet |
| Database | Supabase (PostgreSQL + pgvector) |
| Knowledge | TF-IDF vector search + RAG |
| Build pipeline | Pre-build PDF analysis |

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
#   SUPABASE_URL=https://your-project.supabase.co
#   SUPABASE_ANON_KEY=...
#   SUPABASE_SERVICE_KEY=...

# Set up the database (one-time)
# Run server/supabase-schema.sql in your Supabase SQL Editor

# Build the knowledge base (one-time, ~$50, several hours)
npm run build:knowledge

# Run the app
npm run dev    # server on :3001, client on :5199
```

Open [http://localhost:5199](http://localhost:5199)

---

## Project structure

```
/
├── client/                      # React + Vite frontend
│   └── src/
│       ├── App.jsx              # Layout, header, build status
│       └── components/
│           ├── Chat.jsx         # Chat interface + mode toggle
│           └── Message.jsx      # Message bubbles, chips, citations
├── server/                      # Node/Express backend
│   ├── build-knowledge.js       # Pre-build pipeline
│   ├── supabase-schema.sql      # Database schema — run once in Supabase
│   ├── lib/
│   │   ├── claude.js            # AI integration + RAG + system prompt
│   │   ├── supabase.js          # Supabase client (server + public)
│   │   ├── vectorStore.js       # TF-IDF vector search
│   │   └── parser.js            # PDF and text parsing
│   └── routes/
│       └── chat.js              # API routes
└── source/                      # Drop source PDFs here
```

---

## Notes

- `.env` is gitignored — never commit your API key
- `knowledge-base.json` and `knowledge-cache.json` are gitignored — back these up separately, they represent your built knowledge
- Source PDFs are gitignored — store separately
- Session history persists in Supabase — survives server restarts
