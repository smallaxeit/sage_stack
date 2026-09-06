# SageStack v2 — Multi-Subject, Local-First Architecture

Branch: `developmentlv`
Status: **plan only — no code changed yet**
Supersedes: the Supabase-coupled design on `main` (which still runs, untouched)

---

## 0. The pivot in one paragraph

SageStack today is one hardcoded subject (theology) welded to one hosted database
(Supabase). v2 separates those two things into independent axes: a **storage driver**
(files / local Postgres / — ) and a **subject profile** (theology / medicine / service
manuals / whatever PDFs get fed). Neither knows about the other. Adding a subject
becomes a directory and a JSON file; changing where bytes live becomes an env var.

---

## 1. Verified facts (checked on this machine, 2026-09-05)

These are measured, not assumed — they change what the plan has to build.

| Fact | Evidence |
|---|---|
| PostgreSQL 17 **and** 18 both installed and running | `postgresql-x64-17`, `postgresql-x64-18` services Running |
| PG17 on :5432, PG18 on :5433, both listening | `netstat` shows both LISTENING |
| **pgvector installed in both** (`vector.dll` + `vector.control`) | verified in `C:\Program Files\PostgreSQL\{17,18}\` |
| Supabase surface is small — ~25 call sites, 8 files | all trivial CRUD + one RPC (`match_chunks`) |
| **`sagestack` database is live and bootstrapped** on PG18 :5433 | `postgresql://sage:sage@localhost:5433/sagestack`, pgvector 0.8.6 enabled |
| Owner is `postgres`; `sage` holds `CREATE` on the database and on `public` | ownership deliberately not transferred — a non-owning app role cannot DROP the database |
| Extensions are per-database, not per-instance | `sagestack` started with `installed_version: null` despite pgvector being available on the server |
| PG15+ revoked the historic `CREATE` on `public` for non-owners | `sage` needed an explicit `GRANT USAGE, CREATE ON SCHEMA public` |
| `postgres` superuser password is not `postgres`, and there is no `.pgpass` | auth is `scram-sha-256`; superuser is needed only for the one-time bootstrap |
| No PDF upload route exists | `multer` is a dependency but unused; ingest is drop-files-in-`source/` |
| Chat model is a generation behind | `claude-sonnet-4-6` at [claude.js:138](server/lib/claude.js#L138); `claude-sonnet-5` is cheaper ($2/$10 vs $3/$15 per MTok) and better |

**The big one:** the Postgres + pgvector setup is already done. The single hardest
part of "get off Supabase" — a working local vector database on Windows, built from
source because pgvector ships no Windows binaries — is finished and running. Postgres
is effectively free infrastructure for this project.

---

## 2. What `ask_cooter` gives us

`ask_cooter` is Python; SageStack is Node. **No code ports directly.** But it is the
service-manual use case already solved end-to-end, and its hard-won design decisions
are worth taking wholesale:

| Take | Why it matters here |
|---|---|
| **Vision extraction per page** (Claude reads a rendered PNG, returns structured JSON) | The decisive one. See §3. |
| **HNSW cosine index** | SageStack's `supabase-vector-search.sql` only has IVFFlat, commented out and never built. HNSW is better and ask_cooter proved it works on this pgvector build. |
| **Dual page numbers** — `pdf_page` (file position) + `printed_page` (the label on the page) | They differ because of front matter (ask_cooter validated: PDF 540 == printed 541). Without both, "see page 3-14" citations are unusable. |
| **Resumable per-page commit + retry with model fallback** | A 651-page vision run *will* hit rate limits, transient 529s, and content-filter false positives. Per-page commit means re-run to continue, never restart. |
| **Structured `specs` jsonb + a direct lookup path** | Independent confirmation of the domain-extras pattern in §5 — and a reminder that some queries ("torque spec for X") want SQL, not vector search. |
| **Env-driven model + embedding dim** | Already the right shape. |

And its explicitly logged limitation — *"Single corpus per DB — results rank across
everything in the DB; switch PDFs via a fresh `DATABASE_URL`"* (DESIGN.md §6.2) — is
precisely the problem this plan exists to fix. **SageStack v2 is ask_cooter
generalized to multi-subject, in Node.**

---

## 3. The finding that changes ingestion

SageStack parses PDFs with `pdf-parse` — text extraction only. ask_cooter's corpus was
**651 pages, 191 MB, scanned images with ~0 extractable text.** Sampled pages returned
zero characters.

Service manuals are scans. Older medical references are scans. `pdf-parse` returns
empty string on them and the build silently produces nothing. Plain OCR (Tesseract)
does no better where it counts — it reads body text acceptably and mangles exactly the
tables, exploded diagrams, and wiring schematics that are the entire value of a manual.

So v2 needs **two ingestion paths**, chosen per document:

- **`text`** — `pdf-parse` / plain `.txt`. Fast, free. Correct for Plato, Locke, the KJV.
- **`vision`** — render page → PNG (150 DPI) → Claude vision → structured JSON
  (markdown + tables + figure descriptions + specs). Slow, costs real money
  (ask_cooter measured **$12–18 per 651-page run on `claude-sonnet-5`**, $30–45 on
  opus), and it is the only thing that works on scans.

Auto-detect: extract text from a sample of pages; if the mean character count per page
is below a threshold, the document needs `vision`. Let the subject profile override.

Node equivalent for rendering: `pdf-to-img` or `mupdf-js` (ask_cooter used PyMuPDF).
**This needs a spike — it is the one genuine unknown in the plan.**

---

## 4. Target architecture

Two axes that never learn about each other.

```
                      ┌─────────────────────────────────┐
   subject profile ──▶│  ingest → analyze → embed       │──▶ store driver
   (what & how)       │  (pipeline, subject-agnostic)   │    (where)
                      └─────────────────────────────────┘
```

### 4.1 Store interface — `server/lib/store/index.js`

Picks a driver from `KB_STORE=files|postgres`. Every driver implements:

```
initSubject(subject, { dim })         upsertChunks(subject, chunks)
listSubjects()                        chunksMissingEmbeddings(subject)
getSubjectMeta(subject)               setEmbeddings(subject, [{id, vector}])
dropSubject(subject)                  searchByVector(subject, vec, topK, filters)
saveConceptMap(subject, map)          getPage(subject, docId, pdfPage)
getConceptMap(subject)                findSpecs(subject, query)      // structured lookup
getSession(id) / saveSession / deleteSession
logChat(...) / incrementChunkQuery(...)          // no-op in files driver
```

`searchByVector` taking `subject` is the whole game — it is the one thing today's
`match_chunks()` cannot do.

### 4.2 `files` driver

Per subject, under `data/subjects/<slug>/`:

- `manifest.json` — dim, embed model, doc list, counts, built-at
- `chunks.json` — text + metadata, no vectors
- `vectors.f32` — raw `Float32Array`, `dim × N`, row-major

The binary sidecar matters. 10k chunks × 1024 dims as JSON numbers is ~80 MB of
parse-on-boot; as `Float32Array` it is 40 MB `readFile` straight into a typed array.
Brute-force dot product over 10k × 1024 floats is a few milliseconds — comfortably fast
to roughly 50k chunks per subject, which is far past where these corpora sit.

Zero install, zero daemon, clone-and-run, and git-friendly if you ever want a subject
committed.

### 4.3 `postgres` driver

`pg` + pgvector against the PG18 instance on **:5433** already running here.

**Schema-per-subject, one database.** This is the key structural decision and it
resolves a real constraint: pgvector requires a **fixed dimension per column** to build
an index, but a pluggable embedder means subjects will have different dims
(voyage-3.5 = 1024, `nomic-embed-text` = 768, `all-MiniLM-L6-v2` = 384). One shared
`chunks` table cannot hold all three.

```sql
CREATE SCHEMA medicine;        -- medicine.documents, medicine.pages, medicine.chunks
CREATE SCHEMA theology;        -- theology.chunks  vector(1024)
CREATE SCHEMA softail;         -- softail.chunks   vector(768)
```

One `DATABASE_URL`, `SET search_path` per query, per-subject dimension, per-subject
HNSW index, and `DROP SCHEMA medicine CASCADE` deletes a subject cleanly. Sessions and
analytics stay in `public` and are shared.

### 4.4 Unified data model

Merges ask_cooter's page-centric model with SageStack's document-centric one. `pages`
is optional — a `.txt` of *The Republic* has no meaningful pages; a service manual is
nothing but pages.

```sql
documents(id, slug, title, filename, ingest_mode, page_count, added_at)
pages(id, document_id, pdf_page, printed_page, section, tags[], image_path,
      markdown, extras jsonb)                       -- NULL-able path for text docs
chunks(id, document_id, page_id NULL, chunk_index, text,
       embedding vector(<dim>), summary, difficulty,
       concepts jsonb, themes jsonb, extras jsonb)
CREATE INDEX ... USING hnsw (embedding vector_cosine_ops);
```

### 4.5 Embedder interface — `server/lib/embed/index.js`

`EMBED_DRIVER=voyage|local`, **voyage default** (your call). Drivers expose
`embedDocuments(texts)`, `embedQuery(text)`, `dim`, `modelId`.

Standardize on **`voyage-3.5`** (what ask_cooter uses) over SageStack's `voyage-3`.
Both are 1024-dim so the schema is identical — but **vectors from different models are
not interchangeable**, so this is a re-embed, not a swap. Do it once, now, while the
corpus is small, rather than after five subjects exist.

Record `embedModel` + `dim` in every subject manifest and **refuse to search when the
query embedder doesn't match the subject's** — that mismatch returns plausible-looking
garbage rather than an error, which is the worst possible failure mode.

---

## 5. Subject profiles

A subject is a directory. Adding one touches no code.

```
subjects/
  theology/     subject.json  source/*.pdf
  medicine/     subject.json  source/*.pdf
  softail/      subject.json  source/*.pdf
```

`subject.json` carries everything currently hardcoded:

```jsonc
{
  "slug": "softail",
  "name": "Harley Softail Service Manual",
  "voice": "You are a veteran motorcycle tech...",   // replaces the Keating prompt
  "ingest": { "mode": "auto", "chunkTarget": 1400, "chunkMax": 2200 },
  "embed":  { "driver": "voyage", "model": "voyage-3.5", "dim": 1024 },
  "extract": {                        // subject-specific fields → chunks.extras
    "specs":      "torque values, capacities, clearances — {name, value, unit, notes}",
    "partNumbers":"HD part numbers referenced",
    "procedures": "ordered step sequences"
  },
  "conceptMap": { "enabled": false }   // meaningful for theology, noise for a manual
}
```

### The schema problem this solves

Today's chunk metadata is theology-shaped: `scriptureRefs`, `philosophicalArguments`,
`crossTextConnections`, `traditions`. Those are meaningless for a brake-caliper
rebuild, and a medicine subject needs `drugInteractions` / `contraindications` /
`dosages` that theology has no use for.

Fix: a **generic core** every subject shares — `summary`, `concepts`, `themes`,
`difficulty` — plus a freeform **`extras` jsonb** filled by the `extract` block above,
which is injected into the analysis prompt. One table, one search path, per-subject
richness. ask_cooter's `specs` jsonb plus its `find_specs()` lookup is the same pattern,
already proven in production.

`conceptMap` becomes opt-in. It is genuinely valuable across theology and philosophy;
for a single service manual it is expensive noise.

---

## 6. Phases

### Phase 0 — Rescue the Supabase data ⚠️ do this first

The theology corpus cost real money to build (Haiku analysis + Voyage embeddings). It
is currently the *only* copy, in a hosted database this plan is walking away from.

Extend [rebuild-cache-from-supabase.js](server/scripts/rebuild-cache-from-supabase.js)
— which already paginates `chunks` — into a **full dump**: chunks **+ embeddings** (it
currently skips the `embedding` column, the expensive part) **+ `concept_map` +
`sources`** → `data/exports/theology-<date>/`.

Verify the row count and spot-check a vector before touching anything else. This is
cheap, reversible, and de-risks everything downstream.

### Phase 1 — Store interface + both drivers ✅ done

- [store/index.js](server/lib/store/index.js) — interface, slug validation, canonical chunk shape
- [store/files.js](server/lib/store/files.js) — dense JSONL + `vectors.f32` sidecar
- [store/postgres.js](server/lib/store/postgres.js) — schema-per-subject, HNSW
- [store/parity.test.js](server/lib/store/parity.test.js) — 22 assertions, run against both
- [bootstrap-postgres.sql](server/scripts/bootstrap-postgres.sql) — role, DB, extension

**44/44 passing** (22 per driver), verified against the real `sagestack` database on
PG18 :5433. The suite drops its throwaway subject afterwards; only the two permanent
registry tables remain, owned by `sage`.

`npm test` runs the files driver alone. To include Postgres:

```
TEST_DATABASE_URL=postgresql://sage:sage@localhost:5433/sagestack node --test server/lib/store/parity.test.js
```

It reads `TEST_DATABASE_URL`, deliberately **not** `DATABASE_URL`, so a routine test run
can never write into a working database by accident.

Deferred, as planned: `getPage()` / `findSpecs()` need the `pages` table that only vision
ingestion fills (Phase 4); analytics no-op in files and are outside the parity contract.

### Phase 2 — Subject profiles

Introduce `subjects/`, move theology's hardcoded prompt out of
[claude.js](server/lib/claude.js) into `subjects/theology/subject.json`, thread `subject`
through search → chat → admin. Import the Phase 0 export as subject #1 and confirm the
app behaves exactly as it does on `main`. **That equivalence is the phase gate.**

### Phase 3 — Embedder interface

`voyage` + `local` drivers behind one interface, dim recorded per subject, mismatch
guard. Re-embed theology on `voyage-3.5`.

### Phase 4 — Vision ingestion

Spike the Node PDF→PNG renderer first (the one real unknown). Then port ask_cooter's
per-page loop: render → extract → chunk → embed → store, committed per page, resumable,
with retry and opus↔sonnet fallback.

### Phase 5 — Feed it PDFs

The upload route `multer` was installed for and never wired: drop or upload a PDF →
pick subject → detect mode → ingest with live progress. This is what turns "rebuild the
knowledge base" from a CLI ritual into a feature.

---

## 7. Decisions already made

| Decision | Choice |
|---|---|
| Storage | Both drivers, built together, behind one interface + parity tests |
| Embeddings | Pluggable, **Voyage default**, local driver available |
| Theology data | Export from Supabase now, migrate as subject #1 |
| Postgres target | Existing **PG18 on :5433** (pgvector confirmed present) |
| Subject isolation in PG | **Schema-per-subject**, one database |
| Vector index | HNSW cosine |
| Embedding model | Standardize on `voyage-3.5` (one-time re-embed) |
| Supabase | Export script only — not carried forward as a driver |
| Subjects | **Tenants** — hard isolation, no crossover, enforced by tests (§10) |
| Chat + concept map model | `claude-sonnet-5` (applied) |
| Chunk analysis model | `claude-haiku-4-5` (unchanged — current gen) |
| Voice | Per subject, in `subject.json` |

## 8. Resolved

1. **PG18 on :5433.** ✅
2. **No cross-subject search — subjects are tenants.** ✅ See §10; this is now a
   first-class constraint, not just a feature we skipped.
3. **Node PDF→PNG renderer** — still unverified. Not a question for the operator; a
   spike at the top of Phase 4.
4. **Configurable voice per subject.** ✅ Keating was specific to SageStack-the-theology-
   app; `voice` lives in `subject.json` and every subject sets its own.
5. **`claude-sonnet-5` everywhere.** ✅ Applied — $2/$10 per MTok against
   `claude-sonnet-4-6`'s $3/$15, so cheaper *and* newer. Chunk analysis stays on
   `claude-haiku-4-5` (already current gen). No Opus.

## 10. Multi-client isolation

Subjects are **tenants**, not categories. The working assumption is now multiple
clients/customers on one deployment, with no crossover and enforced guardrails.

**Why the existing design already carries most of this.** The alternative — one shared
`chunks` table with a `subject` column — makes isolation a matter of remembering a
`WHERE` clause on every query, where a single omission leaks every customer at once.
Directory-per-subject and schema-per-subject make it structural instead: there is no
query that returns two subjects' rows without naming both explicitly, and no `WHERE`
clause whose absence widens the blast radius.

**Enforced now:**

- Every store method takes `subject` as its first argument. There is no global read path.
- Slugs are validated against `^[a-z][a-z0-9_]{0,62}$` before becoming a directory name
  or a SQL identifier — the same guard covers path traversal and SQL injection.
- Seven isolation tests in [parity.test.js](server/lib/store/parity.test.js), run against
  both drivers: colliding chunk ids stay distinct, search cannot cross subjects *even on
  a byte-identical query vector*, concept maps are scoped, and dropping one tenant leaves
  the other whole.
- `DROP SCHEMA "<slug>" CASCADE` is a complete, verifiable tenant delete — which matters
  for a deletion request.

**Not yet enforced — the upgrade path when real customers arrive.** Today a single
`sage` role can read every schema; isolation is structural but not privileged. The
database-level version is a Postgres role per tenant with `GRANT USAGE ON SCHEMA <slug>`
to that role only, and a connection pool per tenant. That makes a cross-tenant read fail
at the *database*, not at our code. Deferred deliberately: it needs per-tenant connection
management, and the structural guarantee plus tests covers the single-operator case we
have now. Revisit before the first external client.

## 9. Explicitly not doing

Auth, multi-user, hosting, and remote access. Same call ask_cooter made, same reasons.
This is a private, local, single-operator tool.
