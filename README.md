# SageStack

> *A knowledge base you can question, and check.*

SageStack turns a pile of documents into something you can ask questions of —
and every answer cites the page you can open to verify it.

**Where it stores things and where it runs are both your choice**, and they are
independent of each other. Storage is a driver: plain files, a local Postgres,
a hosted one, Supabase, or a read-only connection to a corpus someone else
built. Deployment is an Express app in a container — a laptop, a VPS, or any
platform that runs Node. Nothing in the design assumes local, and nothing
assumes hosted.

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
| Storage | files, or any Postgres + pgvector (local, managed, Supabase) — pluggable |

Storage and embeddings are independent choices. Neither knows about the other,
and one test suite runs against every storage backend to keep them
interchangeable.

### Storage options

| `KB_STORE` | Backend | When |
|---|---|---|
| `files` | JSON + a binary vector sidecar on disk | default; no database, clone and run |
| `postgres` | any Postgres with pgvector | local, RDS, Neon, Railway, **Supabase** — it is one connection string |
| `askcooter` | an existing ask_cooter corpus, read-only | reuse a corpus rather than rebuilding it |

**Supabase is just Postgres.** Point the `postgres` driver at the connection
string from Supabase's dashboard (Project Settings → Database) and enable
`pgvector` in the SQL editor. Nothing else changes — schema-per-subject, HNSW
indexes and the isolation guarantees all work the same, because they are
ordinary Postgres.

```
KB_STORE=postgres
DATABASE_URL=postgresql://postgres.<ref>:<password>@<region>.pooler.supabase.com:6543/postgres
```

Use the **session pooler** string for a long-lived server. The transaction
pooler does not support the prepared statements the driver relies on.

> Not yet exercised against a live Supabase project on this repo — the path is
> ordinary Postgres, but treat the first run as a verification.

A subject can also carry its **own** `store` block, so different knowledge areas
can live in different places — one on local disk, one in Supabase, one reading
a colleague's database. See `subjects/softail/subject.json`.

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

## Deploying

The server is a plain Express app that also serves the built client, so any
Node host works. A multi-stage `Dockerfile` is included and bakes no secrets —
environment variables are injected at runtime.

```bash
docker build -t sagestack .
docker run -p 3001:3001 --env-file server/.env sagestack
```

Choosing a storage backend is most of the deployment decision:

| Deployment | Storage that fits |
|---|---|
| Laptop / single machine | `files`, or a local Postgres |
| Container on a VPS | local Postgres, or a managed one |
| Ephemeral / serverless filesystem | **not** `files` — the disk does not survive; use Postgres |
| Multi-instance | Postgres, so instances share state |

With `files`, mount a volume at `/app/data` or the knowledge base disappears
with the container. With Postgres, nothing needs to persist locally.

Two things to set for anything public, both off by default:

- `ADMIN_KEY` — without it, the admin and upload routes are **unauthenticated**
- `DEFAULT_SUBJECT` — otherwise a request that names no subject is rejected
  once more than one exists

Chat history is stored server-side per subject, so it follows the store you
chose rather than living in the browser.

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
- Supabase works today through the `postgres` driver (it is Postgres). The
  older REST-based modules — `lib/supabase.js`, `lib/embeddings.js` — are
  parked, not wired; they would only be needed for an environment that cannot
  open a direct database connection. See `ARCHITECTURE_PLAN.md`.
