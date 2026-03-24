# Pending Changes

Items approved for implementation in a future session. No code changes without explicit plan + OK.

---

## UI / Admin Panel

- **Concept map rebuild has no progress feedback in app** — when triggered from Actions tab, the UI shows nothing while it runs. Needs a progress state (e.g. "Building concept map…" indicator) wired into the build-progress.json polling loop.

- **Works loaded count doesn't update after build** — requires server restart to reflect new sources. Should auto-reload knowledge-meta.json when build completes.

- **Embeddings shows NaN% in Status tab** — field name mismatch (`stats.chunks` vs `stats.totalChunks`).

- **Browser tab title and favicon not set** — shows default Vite branding. Should show SageStack name + custom icon (Avatar1.png already in /source/).

- **Sources tab shows stale data until server restart** — sourceStats baked into knowledge-meta.json at build end, but server holds old data in memory until restarted.

---

## Tooling

- **Install `gh` CLI** — `brew install gh && gh auth login` — enables issue tracking, PRs, and GitHub workflow from Claude Code sessions. Once installed, migrate PENDING.md items to GitHub issues as the official backlog.

- **Multi-persona support** — app currently hardcoded to theology/SageStack. Future: switchable personas (different subject, knowledge base, embeddings, system prompt, name/branding) within the same app instance. Each persona = its own source files, Supabase namespace, concept map, and AI identity. Example: SageStack (theology) vs. a bush skills / overlanding persona.

---

## Build Pipeline

- **Concept map JSON parse errors** — Sonnet occasionally returns malformed JSON (truncated or bad escape). Need a retry loop with fallback prompt before hard failing.

- **Live source progress during build** — new sources don't appear in Sources tab until build completes. Should show 0/N pending for sources in queue.
