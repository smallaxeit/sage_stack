# SageStack

> *From scripture to social contract*

A Socratic teaching chatbot that guides students through theology, philosophy, and ethics — from the Bible and Quran to the Vedas and beyond. Powered by Claude AI with a deep pre-analyzed knowledge base built from sacred texts.

---

## What it does

Students ask questions in plain language — casual, curious, skeptical, or blunt. SageStack answers directly with scholarly depth, then ends every response with Socratic questions that push thinking further. It draws only from the loaded source texts, cites its sources, and suggests related topics to explore.

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React + Vite + Tailwind CSS |
| Backend | Node.js + Express |
| AI | Claude Sonnet (claude-sonnet-4-6) |
| Knowledge | TF-IDF vector search + RAG |
| Build | Pre-build PDF analysis pipeline |

## Source texts

- The Holy Bible (KJV)
- Ethiopian Orthodox Bible
- Torah
- The 4 Vedas
- Quran (ClearQuran English translation)
- Buddhist texts

## How it works

### Pre-build pipeline
Drop PDFs into `/source/`, then run:
```bash
npm run build:knowledge
```
This parses → chunks → analyzes each chunk with Claude (extracting concepts, scripture refs, philosophical arguments, cross-text connections) → builds a concept map → generates TF-IDF vectors. Results are cached — only new chunks are billed on subsequent runs.

### Chat
On every message, the top 10 most relevant chunks are retrieved via cosine similarity and injected into the system prompt. Claude responds as a rigorous professor, anchored to the source material.

---

## Setup

```bash
# Install dependencies
npm install
cd server && npm install
cd ../client && npm install

# Add your Anthropic API key
cp server/.env.example server/.env
# Edit server/.env and add ANTHROPIC_API_KEY=sk-ant-...

# Build the knowledge base (one-time, ~$50, takes several hours)
npm run build:knowledge

# Run the app
npm run dev          # starts both server (3001) and client (5199)
```

Open [http://localhost:5199](http://localhost:5199)

---

## Features

- **Streaming responses** — words appear as they're generated
- **Quick / Deep mode** — short accessible answers vs full scholarly treatment
- **Explore chips** — clickable concept pills after each response
- **Source citations** — expandable panel showing which texts were used
- **Dark / Light theme** — persists across sessions
- **Build button** — trigger knowledge rebuild from the UI
- **Progress bar** — live ETA during builds

---

## Project structure

```
/
├── client/          # React + Vite frontend
│   └── src/
│       ├── App.jsx
│       └── components/
│           ├── Chat.jsx
│           └── Message.jsx
├── server/          # Node/Express backend
│   ├── build-knowledge.js   # Pre-build pipeline
│   ├── lib/
│   │   ├── claude.js        # Claude API + RAG
│   │   ├── vectorStore.js   # TF-IDF search
│   │   └── parser.js        # PDF/text parsing
│   └── routes/
│       └── chat.js          # API routes
└── source/          # Drop PDFs here
```

---

## Notes

- `.env` is gitignored — never commit your API key
- `knowledge-base.json` and `knowledge-cache.json` are gitignored (large, regenerable)
- Source PDFs are gitignored — store separately
- Session history is in-memory — clears on server restart
