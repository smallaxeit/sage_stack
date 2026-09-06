# Pending

Approved for a future session. Nothing here is in progress.

---

## UI

- **Per-subject PDF retention and browsing.** Make it a subject setting whether
  the original file is kept, and give the user a real file browser over what a
  subject holds — browse documents, open any page, page through, not just the
  pages a citation happens to point at. Model on ask_cooter's viewer, which is
  already the reference for the split scan/text pane.

- **The header lost its avatar.** `public/avatar.png` is no longer referenced
  after the rebuild; the header is text-only. Put an identity mark back.

- **No way to create a subject from the UI.** It is a directory plus a JSON
  file, and profiles are cached at load, so a new subject needs a restart.

---

## Ingestion

- **Vision ingestion is not implemented.** Scanned PDFs are correctly detected
  and refused, but there is no path to ingest one. Needs a Node PDF→PNG
  renderer (unverified — `pdf-to-img` and `mupdf-js` are the candidates) plus
  per-page Claude vision extraction, resumable per page with retry and model
  fallback. `softail` is configured `"mode": "vision"` and was built externally
  by ask_cooter; nothing here can reproduce it yet.

- **`ingest.mode: "auto"` is never exercised.** Detection exists
  (`detectIngestMode`) and both committed subjects pin `text` or `vision`.

- **Re-ingesting a document leaves orphans.** Chunk ids are
  `<filename>::<index>`, so a re-ingest that produces fewer chunks leaves the
  tail behind. Delete the document's chunks first.

---

## Models

- **Add an `llm/` driver layer for model swapping.** Third instance of a
  pattern already proven twice (`store/`, `embed/`): one interface, several
  drivers, one parity suite. Build `anthropic` plus `openai-compatible` — the
  latter covers Microsoft Foundry, OpenAI, Groq, OpenRouter and a local Ollama
  from the same code, since they all speak the same shape. A Foundry-specific
  SDK is not needed.

  Config belongs per call site, not just per subject, because the three calls
  have opposite economics:

  ```jsonc
  "chat":       { "provider": "anthropic", "model": "claude-sonnet-5" },
  "analysis":   { "provider": "ollama",    "model": "qwen2.5:7b" },
  "conceptMap": { "provider": "foundry",   "model": "gpt-4o-mini" }
  ```

  The prize is **analysis** — the only genuinely expensive call (~$20 per
  5,000 chunks) and the one best suited to a cheap model, being structured
  extraction rather than reasoning. Chat costs cents and benefits most from a
  strong model.

  Two things to measure before trusting a swap, both cheap because the failure
  counters already exist: the analysis prompt demands strict JSON and smaller
  models are worse at it (run 50 chunks, compare parse-failure rates), and the
  strict grounding rules ask for disciplined refusals that a small model will
  follow less reliably.

  Note Foundry is metered Azure, not free. Genuinely free means local (Ollama),
  which the same driver covers.

## Cost

- **Prompt caching is not used, and the prefix is ideal for it.** The system
  prompt is voice + rules + concept map (stable per subject) followed by the
  retrieved passages (per request) — a textbook cache prefix. Measured on
  theology: the concept map alone adds ~3,600 tokens to every single request.
  Caching the stable half would cut that to roughly a tenth on repeat calls.
  Needs `system` split into blocks with `cache_control` on the stable one
  rather than the single concatenated string it is today.

- **The concept map is a recurring cost, not a one-off.** Building it is one
  call; carrying it is 3,600 tokens per question forever. Worth measuring
  whether answers actually improve enough to justify that before enabling it
  on a new subject.

## Retrieval

- **No re-ranking, and no query rewriting.** A follow-up like "what about the
  front one?" embeds literally and retrieves poorly, because only the current
  question is embedded while the model sees the whole conversation.

- **Duplicate detection is not automatic.** The theology import had 434 exact
  duplicates (8%) that silently consumed retrieval slots; they were removed by
  hand. Ingestion should catch this.

- **`READING_LIST.md` was ingested as a source** into theology (2 chunks). It
  is documentation, not content. A bulk build should have an ignore list.

---

## Storage

- **Verify the Supabase path.** Supabase is Postgres, so the existing
  `postgres` driver should work against its connection string with no new
  code — documented in the README but never run against a live project. Needs
  `CREATE EXTENSION vector` in the SQL editor and the **session** pooler
  string (the transaction pooler does not support prepared statements). Worth
  confirming before anyone depends on it. Note this uses a fresh
  schema-per-subject layout, so it does not read the old single-tenant
  `chunks` table — that data was already exported and imported.

- **The REST-based Supabase modules stay parked.** `lib/supabase.js` and
  `lib/embeddings.js` are only needed for an environment that cannot open a
  direct database connection. Promoting them to a real store driver would need
  a `subject` column added to that schema first.

- **Docker image was missing `subjects/`.** Fixed — a container would have
  booted with no knowledge areas at all. Never caught because Docker is not
  installed on the dev machine, so the image has never actually been built.
  Build it once before relying on it.

- **Tenant isolation is structural but not privileged.** One `sage` role can
  read every schema. The real multi-tenant version is a Postgres role per
  tenant with `GRANT USAGE` on only its own schema, and a connection pool per
  tenant, so a cross-tenant read fails at the database rather than in our code.
  Revisit before the first external client.

- **Analytics were not carried forward.** `/api/admin/analytics` returns 501.
  The Supabase-era tables (`chat_logs`, `chunk_analytics`, `usage_summary`,
  `hot_chunks`) have no equivalent. Their "flag hot chunks for deeper
  re-analysis" queue was never drained even when it existed, so rebuild it only
  if the escalation is actually wanted.

---

## Operations

- **Uploads are unauthenticated when `ADMIN_KEY` is unset**, which is the
  default. Fine locally, wrong for any deploy.

- **No structured logging.** Everything is `console.log`.

- **`data/exports/` grows without limit.** The theology export is ~88MB
  (65MB JSONL + 22MB vectors) and nothing prunes old ones.
