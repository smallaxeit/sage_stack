# Pending

Approved for a future session. Nothing here is in progress.

---

## Data that needs a rebuild

- **Rx chunks are oversized and should be re-ingested.** The chunker split only
  on blank lines, and PDF extraction routinely emits none — every line ends in
  a single newline — so a whole page arrived as one "paragraph" and bypassed
  `chunkMax` entirely. 77 of Rx's 121 chunks exceeded the 2200 cap, median 2451,
  largest 4414.

  The chunker is fixed (`splitOversized`), but existing chunks were written by
  the old one and stay as they are until re-ingested. Re-ingesting the five Rx
  PDFs costs analysis and embedding on roughly twice as many chunks — a few
  dollars — and should roughly halve both the tokens per question and the
  latency. Check theology and softail for the same shape before assuming Rx is
  the only one affected.

- **Re-ingesting a document leaves orphans.** Chunk ids are
  `<filename>::<index>`, so a re-ingest producing fewer chunks leaves the tail
  behind. Delete the document's chunks first. This blocks the item above.

- **Failed chunk analysis cannot be retried.** One Rx chunk failed analysis
  (`Spironolactone.pdf::16`, the string "Revised: 4/2026" — a footer, so no
  real loss). There is no backfill that re-runs analysis for chunks missing a
  summary, so the only remedy today is re-ingesting the whole document.

---

## Cost and models

- **The cache TTL is 5 minutes, and questions are often further apart.** A
  question after a longer gap pays the full uncached price again. A 1-hour TTL
  costs 2x input on the write against 1.25x, and holds reads at a tenth for the
  hour — better for interactive use, worth measuring rather than assuming.

- **Multi-provider model drivers.** `config/models.json` now decides which
  model does which job, which was the prerequisite. What is still missing is a
  driver layer behind it — the third instance of a pattern already proven twice
  (`store/`, `embed/`): one interface, several drivers, one parity suite.
  `anthropic` plus `openai-compatible` covers Foundry, OpenAI, Groq, OpenRouter
  and a local Ollama from the same code, since they all speak the same shape.

  The prize is **analysis** — the only genuinely expensive call (~$20 per 5,000
  chunks) and the one best suited to a cheap model, being structured extraction
  rather than reasoning. Chat costs cents and benefits most from a strong model.

  Two things to measure before trusting a swap, both cheap because the failure
  counters already exist: the analysis prompt demands strict JSON and smaller
  models are worse at it (run 50 chunks, compare parse-failure rates), and the
  strict grounding rules ask for disciplined refusals a small model will follow
  less reliably.

- **The concept map is a recurring cost, not a one-off.** Building it is one
  call; carrying it is ~3,600 tokens per question forever. It now sits in the
  cached prefix, so it is billed at a tenth on a warm cache — but it still
  occupies context. Worth measuring whether answers improve enough to justify
  it before enabling it on a new subject.

---

## Retrieval

- **The sources panel shows one entry per document, at the first retrieved
  chunk's page.** With many passages from one document that page is close to
  arbitrary — softail cites p.123 in the answer while the panel offers p.646.
  The inline `[p.N]` links are correct; it is only the panel that is coarse.

- **`contextMode: "all"` is implemented but unused.** It sends every chunk and
  caches them as a stable prefix. Sound for a genuinely small subject; Rx at
  121 oversized chunks took 169 seconds to start answering, so it was backed
  out. Worth revisiting after the re-chunk above.

---

## Testing

- **No tests for `conceptmap.js`, `runtime.js`, or `auth.js`.** `auth.js` is
  the one that matters: it is the gate on everything that spends or destroys,
  and it is currently asserted only by being called.

- **Vision ingestion has never been run end to end.** Extraction is verified on
  individual pages and the resume logic in isolation, but no full
  multi-hundred-page document has been ingested through it. The retry and
  fallback paths are unit-tested against doubles, not real rate limits. (The
  softail scans came from ask_cooter, which did its own run.)

- **`ingest.mode: "auto"` is never exercised.** `detectIngestMode` exists, but
  every committed subject pins `text` or `vision`.

- **The Docker image has never been built.** Docker is not installed on the dev
  machine. A missing `subjects/` copy was caught by reading the Dockerfile, not
  by running it. Build it once before relying on it.

---

## UI

- **Per-subject PDF retention and browsing.** Make it a subject setting whether
  the original file is kept, and give the user a real file browser over what a
  subject holds — browse documents, open any page, page through, not just the
  pages a citation points at.

- **The header lost its avatar.** `public/avatar.png` is no longer referenced
  after the rebuild; the header is text-only.

- **No way to create a subject from the UI.** It is a directory plus a JSON
  file, and profiles are cached at load, so a new subject needs a restart.

- **Cost is not persisted with a conversation.** Sessions store role and
  content only, so reopening one from history shows no cost on past answers.

---

## Storage

- **Verify the Supabase path.** Supabase is Postgres, so the `postgres` driver
  should work against its connection string with no new code — documented but
  never run against a live project. Needs `CREATE EXTENSION vector` and the
  **session** pooler string (the transaction pooler does not support prepared
  statements).

- **The REST-based Supabase modules stay parked.** `lib/supabase.js` and
  `lib/embeddings.js` are unreferenced by the running app and kept
  deliberately: they are the fallback for an environment that cannot open a
  direct database connection. Promoting them to a real store driver needs a
  `subject` column added to that schema first.

- **Tenant isolation is structural but not privileged.** One `sage` role can
  read every schema. The real multi-tenant version is a Postgres role per
  tenant with `GRANT USAGE` on only its own schema, and a connection pool per
  tenant, so a cross-tenant read fails at the database rather than in our code.
  Revisit before the first external client.

- **`data/exports/` grows without limit.** The theology export is ~88MB and
  nothing prunes old ones. `data/pages/` is now similar — softail's scans are
  733MB.

- **Analytics were not carried forward.** `/api/admin/analytics` returns 501.
  The Supabase-era tables have no equivalent. Their "flag hot chunks for deeper
  re-analysis" queue was never drained even when it existed, so rebuild it only
  if the escalation is actually wanted.

---

## Operations

- **Uploads are unauthenticated when `ADMIN_KEY` is unset**, which is the
  default. Fine locally, wrong for any deploy. The server warns at boot.

- **No structured logging.** Everything is `console.log`.

- **`READING_LIST.md` was ingested as a source** into theology (2 chunks). It
  is documentation, not content. A bulk build should have an ignore list.
