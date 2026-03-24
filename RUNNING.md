# Running SageStack Locally

## First time setup

```bash
npm run install:all
```

Copy and fill in your API keys:
```bash
cp server/.env.example server/.env
```

Required keys in `server/.env`:
```
ANTHROPIC_API_KEY=sk-ant-...
VOYAGE_API_KEY=pa-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_KEY=...
ADMIN_KEY=your-admin-password
```

---

## Run the app

```bash
npm run dev
```

- Client: http://localhost:5199
- Server: http://localhost:3001

Both start together. Hot reload is active — client changes apply instantly, server restarts on save.

---

## Admin panel

Click the **⚙** icon in the top-right corner of the app.

- **Status tab** — Works loaded, traditions, embeddings coverage, live build progress
- **Sources tab** — per-source analyzed percentage
- **Actions tab** — trigger builds and rebuilds

Admin password = value of `ADMIN_KEY` in `server/.env`

---

## Adding new source files

1. Drop a `.pdf` or `.txt` file into `/source/`
2. Add a friendly name entry in `server/lib/claude.js` → `SOURCE_NAMES` map
3. Open admin panel → Actions → **Load New Knowledge**

---

## If the cache is lost

```bash
node server/scripts/rebuild-cache-from-supabase.js
```

Restores all prior analysis from Supabase. **Never re-run a full build from scratch** — all chunk analysis lives in Supabase and the cache is just a local speed layer.
