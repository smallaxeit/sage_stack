# SageStack

> *A knowledge base you can question, and check.*

SageStack turns a pile of documents into something you can ask questions of —
and every answer cites the page you can open to verify it.

It runs entirely on your machine. Documents, embeddings, and chat history stay
local unless you deliberately point it somewhere else.

---

## What it is

A **knowledge area** (a "subject") is a directory with a `subject.json`. That
file holds everything domain-specific: the voice the assistant answers in, how
documents are chunked, which embedding model to use, and what metadata to pull
out of each chunk. Adding a new area — medicine, service manuals, case law,
whatever you have PDFs for — touches no code.

Subjects are **isolated from each other**. A directory per subject on disk, a
Postgres schema per subject in a database. There is no query that returns two
subjects' rows without naming both, which makes the separation structural
rather than a `WHERE` clause someone has to remember.

Two areas ship as working examples:

| Subject | What it is | Where its data lives |
|---|---|---|
| `theology` | 12 religious and philosophical texts, 4,999 chunks | local Postgres |
| `softail` | A scanned Harley service manual, 1,063 chunks over 644 pages | connects to an existing ask_cooter database, read-only |

---

## How it works

### Ingestion

```
document → pages → chunks → (analysis) → embeddings → store
```

Each stage has different requirements, and the pipeline runs as far as your
environment allows rather than failing whole:

| Stage | Needs | Without it |
|---|---|---|
| parse + chunk | nothing | — |
| embed | `VOYAGE_API_KEY`, or `EMBED_DRIVER=local` | stored but **not searchable** |
| analyse | `ANTHROPIC_API_KEY` | no concepts, summaries, or subject-specific fields |

Anything skipped is reported, not hidden.

PDFs are parsed **page by page**, so every chunk knows which page it came from
and citations can link to it. Two page numbers are kept: the position in the
file, and the label printed on the page. They differ wherever there is front
matter — by 17 pages in one of the sample texts.

**Scanned PDFs are detected and refused**, rather than silently producing an
empty knowledge base. Text extraction returns almost nothing for a scan, and
nothing errors, so the check is explicit. Those need vision ingestion, which is
not implemented yet — the `softail` corpus was built that way externally.

### Answering

```
question → embed → vector search (top K) → passages + voice → Claude → cited answer
```

Retrieval is scoped to one subject at every step. The assistant is told to cite
pages as `[p.419]`, and the interface turns that into a link that opens the
page — **but only when the retrieved passages actually have page numbers**.
Asking for citations that can't exist makes a model invent them, so the
instruction is chosen per request from what was actually retrieved.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite |
| Backend | Node + Express |
| Chat | `claude-sonnet-5` (per subject, configurable) |
| Chunk analysis | `claude-haiku-4-5` — one call per chunk, so the cheap tier |
| Concept map | `claude-sonnet-5` — aggregates what analysis extracted |
| Embeddings | Voyage (`voyage-3.5`) or a local ONNX model, pluggable |
| Storage | local files, or Postgres + pgvector, pluggable |

Storage and embeddings are independent choices. Neither knows about the other,
and one test suite runs against every storage backend to keep them
interchangeable.

---

## Setup

```bash
npm run install:all

cp server/.env.example server/.env
# then fill in the keys — see the comments in that file
```

**Storage.** The default (`KB_STORE=files`) needs no database. For Postgres:

```bash
# once, as a superuser — creates the role, database, and pgvector extension
psql -U postgres -p 5433 -f server/scripts/bootstrap-postgres.sql
```

```
KB_STORE=postgres
DATABASE_URL=postgresql://sage:sage@localhost:5433/sagestack
```

**Embeddings.** Either a Voyage key (`pa-…` from dash.voyageai.com), or:

```
EMBED_DRIVER=local
npm --prefix server install @huggingface/transformers
```

Local models are 384/768-dim rather than 1024, so switching means re-embedding
everything — the vectors are not interchangeable.

**Run it:**

```bash
npm run build      # build the client
npm start          # http://localhost:3001

npm run dev        # or: server + client with hot reload
```

---

## Adding a knowledge area

```
subjects/medicine/
  subject.json
  source/            drop PDFs here for a bulk build
```

Minimum viable `subject.json`:

```jsonc
{
  "name": "Clinical Reference",
  "voice": "You are a careful clinical reference…",
  "embed":     { "model": "voyage-3.5", "dim": 1024 },
  "retrieval": { "topK": 8 },
  "extract": {
    "dosages":         "dose, route and frequency, each as {drug, dose, route, frequency}",
    "contraindications": "conditions under which this must not be used"
  }
}
```

The `extract` block is what lets one pipeline serve unlike domains. A generic
core — summary, concepts, themes, difficulty — is shared by every subject;
everything else is driven by config into a freeform `extras` field. Theology
asks for scripture references, a service manual asks for torque specs.

Then either drop files in `source/` and hit **Build**, or upload through the
Knowledge screen.

---

## Project structure

```
subjects/<slug>/subject.json     what a knowledge area is
data/                            local stores, uploads, exports (gitignored)

server/
  index.js                       express app; reports subject status at boot
  lib/
    runtime.js                   subject registry — profile + store + embedder
    subjects.js                  profile loading, validation, prompt assembly
    claude.js                    retrieval-augmented answering, per subject
    conceptmap.js                concept map build
    store/                       files | postgres | askcooter  (+ parity tests)
    embed/                       voyage | local               (+ tests)
    ingest/                      parse → chunk → analyse → embed → store
  routes/                        chat | admin | documents
  scripts/                       bootstrap-postgres, export/import

client/src/
  App.jsx                        shell, sidebar, subject switching
  components/
    Chat.jsx                     streaming chat
    Message.jsx                  markdown + inline [p.N] citation links
    PageViewer.jsx               scan | extracted text, zoom, page flip
    KnowledgePanel.jsx           what is loaded, and uploading more
```

---

## Testing

```bash
npm test

# include the Postgres backend
TEST_DATABASE_URL=postgresql://sage:sage@localhost:5433/sagestack npm test
```

The store suite runs **identical assertions against every backend**, plus
isolation tests asserting that search cannot cross subjects even on a
byte-identical query vector. That suite is what keeps "files or Postgres" a
real choice rather than two implementations that quietly drift.

Postgres tests read `TEST_DATABASE_URL`, deliberately not `DATABASE_URL`, so a
routine test run can never write into a working database.

---

## Notes

- `server/.env` is gitignored. `server/.env.example` documents every variable.
- `data/` is gitignored — regenerable, large, and often derived from copyrighted
  sources.
- Source PDFs are not committed.
- **Vectors from different embedding models are not interchangeable**, and a
  mismatch does not error — it silently returns confident nonsense. Every
  subject records the model that built it, and a query with the wrong one is
  refused. `voyage-3` and `voyage-3.5` are both 1024-dim, so only the model
  check can tell them apart.
- Supabase support is parked rather than removed — see `ARCHITECTURE_PLAN.md`.
