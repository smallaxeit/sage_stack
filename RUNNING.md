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
| `ADMIN_KEY` | unset means admin and upload routes are open — fine locally |

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
  ok   softail      1063 chunks, 1063 embedded (voyage-3.5, 1024d)
  ok   theology     4999 chunks, 4999 embedded (voyage-3, 1024d)
```

`--` means not ready. The reason is on the line.

---

## Loading documents

**One at a time:** Knowledge screen → drop a PDF on the upload area. Progress
streams per stage.

**In bulk:** put files in `subjects/<slug>/source/`, then `POST /api/build`
(or the Build action). Poll `/api/build-progress`.

Supported: PDF, TXT, MD, JSON, CSV.

A scanned PDF will be **refused** with a message saying so. Text extraction
returns almost nothing for a scan and raises no error, so the check is
explicit — otherwise you would get an empty knowledge base reported as success.

---

## Adding a knowledge area

Create `subjects/<slug>/subject.json`. Only `voice` is required; everything
else has a default. See `subjects/theology/` and `subjects/softail/` for a
worked example of each shape.

The slug becomes a directory name and a SQL identifier, so it must be
lowercase, start with a letter, and contain only letters, digits and
underscores.

Nothing needs restarting for content changes; a new or edited `subject.json`
does need a restart, since profiles are cached.

---

## Connecting to an existing corpus

A subject can read from a database it does not own:

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
is a per-query cost too. Worth it across a broad corpus; noise for a single
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
