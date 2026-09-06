# Pending

Approved for a future session. Nothing here is in progress.

---

## UI

- **Bring back the admin panel.** It was deleted in the UI rebuild (`83ab093`)
  and its stats folded into the Knowledge screen — that was a judgement call,
  not a request, and the panel is wanted back. Recover with:
  `git show 83ab093^:client/src/components/AdminPanel.jsx`
  Restyle to the current palette and make it per-subject rather than global.
  **Do not restore it verbatim:** it hardcodes
  `const ADMIN_KEY = 'sagestack-admin-2026'` in the client bundle, which ships
  the admin key to every visitor. It must read from the user instead.

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

- **Supabase is parked, not wired.** `lib/supabase.js` and `lib/embeddings.js`
  are kept for a future public deploy but nothing imports them. Two routes if
  it happens: point the existing `postgres` driver at Supabase's connection
  string (no new code — Supabase is Postgres), or promote the REST path to a
  real store driver for environments that cannot open a direct TCP connection.
  **Either needs a `subject` column added first** — the existing schema is
  single-tenant, which is exactly what this architecture moved away from.

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
