# SageStack

> *A knowledge base you can question, and check.*

SageStack turns a pile of documents into something you can ask questions of —
and every answer cites the page you can open to verify it.

**Where it stores things and where it runs are both your choice**, and they are
independent of each other. Storage is either files on disk or Postgres —
wherever that Postgres happens to be. Deployment is an Express app in a
container: a laptop, a VPS, or any platform that runs Node. Nothing in the
design assumes local, and nothing assumes hosted.

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

Three areas ship as working examples, and they are deliberately unalike — a
pipeline that serves all three is not overfitted to any one of them:

| Subject | What it is | Where its data lives |
|---|---|---|
| `theology` | 12 religious and philosophical texts, 4,997 chunks | Postgres / Supabase |
| `softail` | A scanned Harley service manual, 1,063 chunks over 644 pages | Postgres |
| `rx` | 5 prescription drug labeling documents, 173 chunks | Postgres |

Each one broke something the others did not. `theology` is plain text with no
page numbers, so it proved that asking for page citations when none exist makes
a model invent them. `softail` is a scan with no extractable text at all, which
is what vision ingestion exists for. `rx` is the one where the reader's own
context matters — the drugs they currently take — so it drives the preference
list and the per-item retrieval floor.

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
| analyze | `ANTHROPIC_API_KEY` | no concepts, summaries, or subject-specific fields |

Anything skipped is reported, not hidden.

PDFs are parsed **page by page**, so every chunk knows which page it came from
and citations can link to it. Two page numbers are kept: the position in the
file, and the label printed on the page. They differ wherever there is front
matter — by 17 pages in one of the sample texts.

**Scanned PDFs take a different route.** Text extraction returns almost
nothing for a scan and raises no error, so the check is explicit: a document
with too little text is detected and sent to vision ingestion, which renders
each page and reads it with a vision model. That is the only thing that works
on a scan — plain OCR reads body text acceptably while mangling the tables and
diagrams that are usually the point.

Vision ingestion commits page by page, so an interrupted run resumes rather
than restarting, and a page that fails is reported rather than sinking the
batch. It costs about **$0.01 per page**; the pipeline estimates before
starting and reports actual usage after.

### Answering

```
question → embed → vector search (top K) → passages + voice → Claude → cited answer
```

Retrieval is scoped to one subject at every step. The assistant is told to cite
pages as `[p.419]`, and the interface turns that into a link that opens the
page — **but only when the retrieved passages actually have page numbers**.
Asking for citations that can't exist makes a model invent them, so the
instruction is chosen per request from what was actually retrieved.

**Every answer shows what it cost.** A single figure under the reply, with the
token breakdown in the tooltip. It is there because the number is not
intuitive: the same question against the same subject swings by 10x on whether
the cached prefix was still warm, and nothing else in the answer reveals that.
Estimating from the outside goes wrong in both directions — a measured Rx
question came to $0.166 against a $0.019 estimate, because dense drug labeling
runs ~2.5 chars/token rather than the ~3.7 of prose, and because ranked
retrieval never gets cache hits (its passages differ every question by
definition).

**Ranking is a compromise, and a small subject need not make it.** Set
`retrieval.contextMode: "all"` and every chunk goes to the model on every
question. Ranking exists to choose what will not fit; when it all fits, choosing
is pure downside. It is also cheaper than it looks — identical passages every
question form a stable prefix, so they are cached and read back at a tenth of
the input price. Past `maxContextChars` the subject falls back to search rather
than truncating, because silently dropping the tail is the failure this avoids.

**Where ranking is still used, a preference list gets a floor.** A subject can
nominate things the reader currently cares about — for Rx, the drugs they are
taking — via `retrieval.filterKey`. Matching passages are boosted, never
required, so "is it safe to add ibuprofen?" still works. But a boost alone let
the drug with the most pages take every slot: four drugs on the list, and the
two rosuvastatin inserts crowded out all 24 amlodipine passages, so the answer
called amlodipine undocumented. So each listed item is also guaranteed its
best-scoring passage, and anything missing from the pool entirely gets its own
search.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite |
| Backend | Node + Express |
| Models | `config/models.json` — one model per job (see below) |
| Embeddings | Voyage (`voyage-3.5`) or a local ONNX model, pluggable |
| Storage | files, or any Postgres + pgvector (local, managed, Supabase) — pluggable |

### Models

Every model the app calls lives in [`config/models.json`](config/models.json),
keyed by **purpose** rather than scattered through the code:

| Purpose | Default | Why |
|---|---|---|
| `chat` | `claude-sonnet-5` | answers from retrieved passages |
| `rewrite` | `claude-haiku-4-5` | makes a follow-up standalone; ~250 tokens in |
| `analysis` | `claude-haiku-4-5` | one call per chunk, so the cheap tier matters most |
| `conceptMap` | `claude-sonnet-5` | one long call over what analysis extracted |
| `vision` | `claude-sonnet-5` | reads scanned pages, falls back to Opus per page |
| `embed` | `voyage-3.5` | query and chunk vectors |

Override for one run with `SAGESTACK_MODEL_CHAT=…` (any purpose, SCREAMING_SNAKE).
A subject can also name its own `chat.model` or `embed.model`.

The same file holds **prices**, and they are the only copy. Three existed
before: the chat path priced Sonnet at $3/$15 while the vision estimator and
the admin panel both said $2/$10, so every pre-build estimate was a third low.
A model with no price on file is reported as unpriced rather than free, and the
server says so at boot.

Storage and embeddings are independent choices. Neither knows about the other,
and one test suite runs against every storage backend to keep them
interchangeable.

### Storage options

There are two backends: files, and Postgres.

| `KB_STORE` | Backend | When |
|---|---|---|
| `files` | Files on disk — JSON plus a binary vector sidecar | default; no database, clone and run |
| `postgres` | Postgres + pgvector | anywhere it runs — local, RDS, Neon, Railway, Supabase |
| `askcooter` | Postgres + pgvector, read-only | reading an ask_cooter database in place |

All three rows are one of two technologies. `askcooter` is Postgres with a
different table layout — ask_cooter's `pages`/`chunks` schema instead of
SageStack's schema-per-subject — so it maps that shape onto the canonical chunk
on the way out and refuses writes rather than dropping them silently.

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

A subject can also carry its **own** `store` block, so different knowledge
areas can live in different databases rather than sharing one. That is the
cleanest answer for multi-tenancy: a tenant owns its whole database instead of
a schema inside a shared one. See `RUNNING.md`.

Prefer importing over reading in place. Reading in place keeps a subject on its
own code path and tied to another database's layout, so it earns its keep only
when that database must stay live — ask_cooter still runs standalone against
its own, which is why the driver exists. Otherwise import:
`server/scripts/import-askcooter.js` copies chunks, embeddings and page scans
without modifying the source. `softail` came across that way and is now an
ordinary Postgres subject.

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
| Laptop / single machine | `files`, or Postgres |
| Container on a VPS | Postgres |
| Ephemeral / serverless filesystem | **not** `files` — the disk does not survive; use Postgres |
| Multi-instance | Postgres, so instances share state |

With `files`, mount a volume at `/app/data` or the knowledge base disappears
with the container. With Postgres, nothing needs to persist locally.

Two things to set for anything public, both off by default:

- `ADMIN_KEY` — without it, upload, build, delete and the admin actions are
  **unauthenticated**. Reading stays open either way.
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
config/models.json               which model does which job, and what it costs
data/                            local stores, uploads, page scans (gitignored)

server/
  index.js                       express app; reports subject status at boot
  lib/
    runtime.js                   subject registry — profile + store + embedder
    subjects.js                  profile loading, validation, prompt assembly
    claude.js                    retrieval-augmented answering, per subject
    models.js                    the model registry — purpose → model
    pricing.js                   what a question cost, from reported usage
    prefer.js                    soft preference filtering + per-item coverage
    rewrite.js                   makes a follow-up question standalone before search
    conceptmap.js                concept map build
    auth.js                      the admin-key gate
    store/                       files | postgres | askcooter  (+ parity tests)
    embed/                       voyage | local               (+ tests)
    ingest/                      parse → chunk → analyze → embed → store,
                                 plus render + vision for scans
  routes/                        chat | admin | documents
  scripts/                       bootstrap-postgres, export/import,
                                 import-askcooter

client/src/
  App.jsx                        shell, sidebar, subject and conversation switching
  api.js                         fetch with the admin key attached
  components/
    Chat.jsx                     streaming chat
    Message.jsx                  markdown + inline [p.N] citation links
    PageViewer.jsx               scan | extracted text, zoom, page flip
    DocumentBrowser.jsx          browse documents and open any page
    KnowledgePanel.jsx           what is loaded, and uploading more
    AdminPanel.jsx               per-subject stats and pipeline actions
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
- `source/library/` **is** committed — it is a curated reading list of
  public-domain texts, and the point is that it travels with the repo. What is
  not committed is anything uploaded at runtime: those land in `data/`.
- **Vectors from different embedding models are not interchangeable**, and a
  mismatch does not error — it silently returns confident nonsense. Every
  subject records the model that built it, and a query with the wrong one is
  refused. `voyage-3` and `voyage-3.5` are both 1024-dim, so only the model
  check can tell them apart.
- Supabase works today through the `postgres` driver (it is Postgres). The
  older REST-based modules — `lib/supabase.js`, `lib/embeddings.js` — are
  parked, not wired; they would only be needed for an environment that cannot
  open a direct database connection. See `ARCHITECTURE_PLAN.md`.
