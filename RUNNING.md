# Running SageStack

## First run

```bash
npm run install:all
cp server/.env.example server/.env    # then fill it in
```

Nothing is strictly required to boot. The server starts and reports what each
subject is missing rather than refusing to run — you need the admin screens
most when something is unbuilt.

What each key unlocks:

| Variable | Without it |
|---|---|
| `VOYAGE_API_KEY` (or `EMBED_DRIVER=local`) | documents ingest but **nothing is searchable** |
| `ANTHROPIC_API_KEY` | no chat, and ingestion stores no concepts or summaries |
| `DATABASE_URL` | only needed for `KB_STORE=postgres` |
| `ADMIN_KEY` | unset means upload, build and delete are unauthenticated — fine locally |

---

## Storage

**Files** (default, no database):

```
KB_STORE=files
```

Everything lands under `data/subjects/<slug>/`.

**Postgres + pgvector:**

```bash
# once, as a superuser — idempotent, safe to re-run
psql -U postgres -p 5433 -f server/scripts/bootstrap-postgres.sql
```

```
KB_STORE=postgres
DATABASE_URL=postgresql://sage:sage@localhost:5433/sagestack
```

The bootstrap creates the `sage` role, the database, and the `vector`
extension. It leaves ownership with `postgres` and grants what the app needs —
a non-owning app role cannot drop the database.

Note pgvector is enabled **per database**, not per server. A fresh database
starts without it even if other databases on the same instance have it.

---

## Locking it down

`ADMIN_KEY` gates everything that spends money, writes, or deletes: upload,
build, embedding backfill, concept map rebuild, document delete. Reading stays
open — a knowledge base exists to be read.

```
ADMIN_KEY=some-long-random-string
```

Unset, the gate is open and the server says so at boot. That is right for a
local single-operator run and wrong for anything reachable from elsewhere.

In the UI the key is entered once in the Admin panel (⚙) and kept in
localStorage; every screen that mutates sends it from there.

---

## Run

```bash
npm run build && npm start      # http://localhost:3001
npm run dev                     # server + client with hot reload
```

`npm start` serves the built client from Express on one port. `npm run dev`
runs Vite separately.

At boot the server prints each subject's state:

```
Store: postgres
  ok   rx            173 chunks,  173 embedded (voyage-3.5, 1024d)
  ok   softail      1063 chunks, 1063 embedded (voyage-3.5, 1024d)
  ok   theology     4997 chunks, 4997 embedded (voyage-3, 1024d)
```

`--` means not ready. The reason is on the line.

---

## Loading documents

**One at a time:** Knowledge screen → drop a PDF on the upload area. Progress
streams per stage.

**In bulk:** put files in `subjects/<slug>/source/`, then `POST /api/build`
(or the Build action). Poll `/api/build-progress`.

Supported: PDF, TXT, MD, JSON, CSV.

**A scanned PDF needs vision ingestion.** Text extraction returns almost
nothing for a scan and raises no error, so the check is explicit: too little
text and ingestion stops and says so, rather than reporting an empty knowledge
base as success.

To ingest one, set the subject's `ingest.mode` to `"vision"`. Each page is
rendered and read by a vision model — the only thing that works on a scan, since
plain OCR mangles exactly the tables and diagrams that matter.

```jsonc
"ingest": { "mode": "vision", "renderScale": 2, "visionModel": null }
```

`renderScale` trades image size against legibility: 2 (~150 DPI) is enough for
body text and table rules; a dense wiring diagram may want 3, at roughly double
the cost. `visionModel` overrides the default.

It costs about **$0.01 per page** — call it $7 for a 650-page manual. The run
estimates before starting and reports actual usage after.

Pages are committed one at a time, so an interrupted run **resumes** rather than
restarting: re-run the same command and pages already stored are skipped. Pages
that fail are collected and reported instead of sinking the batch.

Vision ingestion requires `ANTHROPIC_API_KEY`. There is no offline path for a
scan — the page has to be looked at.

---

## Adding a knowledge area

Create `subjects/<slug>/subject.json`. Only `voice` is required; everything
else has a default. Three worked examples ship, one per shape: plain text with
no pages (`subjects/theology/`), a scan read by vision (`subjects/softail/`),
and one driven by a reader's own list (`subjects/rx/`).

The slug becomes a directory name and a SQL identifier, so it must be
lowercase, start with a letter, and contain only letters, digits and
underscores.

Nothing needs restarting for content changes; a new or edited `subject.json`
does need a restart, since profiles are cached.

---

## Reading an ask_cooter database in place

A subject can read an ask_cooter database directly, instead of importing it:

```jsonc
"store": {
  "driver": "askcooter",
  "connectionStringEnv": "ASKCOOTER_DATABASE_URL",
  "imageDirEnv": "ASKCOOTER_IMAGE_DIR",
  "sourceName": "Softail-1984-1999-Repair-Manual-Harley-Davidson.pdf",
  "embedModel": "voyage-3.5",
  "dim": 1024
}
```

Any key ending in `Env` names an environment variable holding the real value,
so connection strings stay out of a committed file.

Such a store is **read-only** — writes throw rather than silently doing
nothing, and the UI hides the upload box.

### Importing instead

Reading in place keeps one subject on a different code path and pointed at a
second database. Prefer it only when that database has to stay live — ask_cooter
still runs standalone against its own. Otherwise import:

```bash
node server/scripts/import-askcooter.js --subject softail --dry-run
node server/scripts/import-askcooter.js --subject softail
```

Chunks come across with their embeddings intact — they cost real money to
produce, and re-embedding would both spend that again and change the vectors —
along with page text and the rendered scans, which land in `data/pages/<subject>/`.
The source database is only read, so the other project keeps working. Then
delete the `store` block from the subject and it is an ordinary subject.

The import verifies itself: counts on both sides, page text, section list, and
a component-wise comparison of the first vector, which is the check that catches
a copy that shuffled embeddings between chunks — the failure that otherwise
stays silent and returns confident nonsense.

---

## Choosing models

`config/models.json` decides which model does which job. Nothing in the code
names a model.

```jsonc
"purposes": {
  "chat":       { "model": "claude-sonnet-5", "maxTokens": 4096 },
  "rewrite":    { "model": "claude-haiku-4-5", "maxTokens": 200 },
  "analysis":   { "model": "claude-haiku-4-5" },
  "conceptMap": { "model": "claude-sonnet-5" },
  "vision":     { "model": "claude-sonnet-5", "fallback": "claude-opus-5" },
  "embed":      { "model": "voyage-3.5", "dim": 1024 }
}
```

Precedence, narrowest first: an explicit argument in code, then the subject's
own profile (`chat.model`, `embed.model`), then `SAGESTACK_MODEL_<PURPOSE>`,
then this file. So a one-off experiment needs no edit:

```bash
SAGESTACK_MODEL_ANALYSIS=claude-opus-5 npm start
```

**`analysis` is the one worth thinking about.** It runs once per chunk, so it
is the only genuinely expensive call — roughly $20 per 5,000 chunks. `chat`
runs once per question and costs cents. Spending on `chat` and economizing on
`analysis` is usually the right way round.

Changing `embed.model` means re-embedding everything; see below.

### Prices

The same file holds prices, in USD per million tokens, and it is the only copy
in the project. Update them when they change:

```jsonc
"pricing": {
  "text":      { "claude-sonnet-5": { "input": 3, "output": 15 } },
  "embedding": { "voyage-3.5": 0.06 }
}
```

Cache rates are derived from the input rate rather than listed per model,
because that is how they are billed: a 5-minute write is 1.25x input, a 1-hour
write 2x, a read a tenth.

A model with no price still works — it just cannot be costed, so answers show
no figure. The server names any such model at boot.

---

## Embedding models

**Vectors from different models are not interchangeable, and a mismatch does
not error.** It returns confident nonsense ranked by a similarity that means
nothing. Every subject records the model that built it, and a query with the
wrong one is refused.

`voyage-3` and `voyage-3.5` are both 1024-dim, so a dimension check cannot
tell them apart — only the model name can.

Changing `embed.model` on a subject that already has vectors means re-embedding
all of them.

---

## Backfilling embeddings

If documents were ingested before an embedding key was available:

```
POST /api/admin/build-embeddings?subject=<slug>
```

Embeds every chunk that has no vector, in batches, and leaves the rest alone.

---

## Concept map

Opt-in per subject (`conceptMap.enabled`). It aggregates the concepts that
per-chunk analysis already extracted, so it costs a few calls rather than one
per chunk — but it is injected into **every** request's system prompt, so it
is a per-query cost too. Worth it across a broad documents; noise for a single
manual.

```
POST /api/admin/build-concept-map?subject=<slug>
GET  /api/admin/concept-map-progress
```

Requires chunks that have been through analysis. It will refuse with an
explanation if there are no extracted concepts to work from.

---

## Migrating off Supabase

```bash
npm run export:supabase                                   # dump to data/exports/
npm run import:export -- --dir data/exports/<name>        # load into a subject
```

The export writes verbatim API responses to `raw/` **before** transforming
anything, so a bug in the transform cannot cost you the rescue. It verifies
itself: row count against the table's own count, vector file byte size, and an
L2 norm on the first vector.

The import refuses if the subject's configured embedding model does not match
the export's. That check is the point — see above.

---

## Tests

```bash
npm test
TEST_DATABASE_URL=postgresql://sage:sage@localhost:5433/sagestack npm test
```

Postgres tests read `TEST_DATABASE_URL`, deliberately not `DATABASE_URL`, so a
routine run cannot write into a working database. The suite creates a throwaway
subject and drops it.

---

## Troubleshooting

**"has no built knowledge base yet"** — the subject has no chunks. Load documents.

**Chat fails with a model mismatch** — `embed.model` in `subject.json` disagrees
with what actually built the vectors. Fix the profile, or re-embed.

**Chunks stored but not searchable** — ingestion ran without an embedder. Set a
key and run the backfill.

**`pgvector is not enabled in this database`** — run the bootstrap SQL as a
superuser. Extensions are per-database.

**Port 3001 already in use** — an earlier server is still running. On Windows:
`Get-NetTCPConnection -LocalPort 3001 -State Listen | Stop-Process -Id { $_.OwningProcess } -Force`
