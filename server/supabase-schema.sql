-- ============================================================
-- SageStack — Supabase Schema
-- Run this in: console.supabase.com → SQL Editor → New Query
-- ============================================================

-- Enable pgvector for semantic search (future upgrade)
create extension if not exists vector;

-- ============================================================
-- CHUNKS TABLE
-- Stores every analyzed chunk from the knowledge pipeline
-- ============================================================
create table if not exists chunks (
  id                      uuid primary key default gen_random_uuid(),
  source                  text not null,               -- source filename (e.g. "Torah.pdf")
  chunk_index             integer not null,             -- position within source
  text                    text not null,               -- raw chunk text
  summary                 text,                        -- AI-generated summary
  difficulty              text,                        -- beginner / intermediate / advanced
  origin_context          text,                        -- historical/cultural context
  concepts                jsonb default '[]',          -- extracted concepts
  themes                  jsonb default '[]',          -- theological/philosophical themes
  scripture_refs          jsonb default '[]',          -- scripture references
  philosophical_arguments jsonb default '[]',          -- logical arguments
  cross_text_connections  jsonb default '[]',          -- links to other traditions
  tfidf_vector            jsonb default '{}',          -- TF-IDF weights (current search)
  embedding               vector(1536),                -- semantic embedding (future pgvector)
  created_at              timestamptz default now(),
  unique(source, chunk_index)
);

-- Index for fast source filtering
create index if not exists chunks_source_idx on chunks(source);
-- Index for concept/theme search
create index if not exists chunks_concepts_idx on chunks using gin(concepts);
create index if not exists chunks_themes_idx on chunks using gin(themes);

-- ============================================================
-- CONCEPT MAP TABLE
-- Stores the AI-generated cross-tradition concept map
-- ============================================================
create table if not exists concept_map (
  id              uuid primary key default gen_random_uuid(),
  core_themes     jsonb default '[]',
  concepts        jsonb default '[]',
  relationships   jsonb default '[]',
  learning_path   jsonb default '[]',
  traditions      jsonb default '[]',
  built_at        timestamptz default now()
);

-- ============================================================
-- SESSIONS TABLE
-- Replaces in-memory session Map — persists across restarts
-- ============================================================
create table if not exists sessions (
  id          text primary key,                        -- sessionId from client
  messages    jsonb default '[]',                      -- full conversation history
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Auto-update updated_at on session changes
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger sessions_updated_at
  before update on sessions
  for each row execute function update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table chunks enable row level security;
alter table concept_map enable row level security;
alter table sessions enable row level security;

-- Chunks and concept map — public read, service-role write
create policy "chunks_public_read" on chunks for select using (true);
create policy "chunks_service_write" on chunks for insert with check (true);
create policy "chunks_service_update" on chunks for update using (true);

create policy "concept_map_public_read" on concept_map for select using (true);
create policy "concept_map_service_write" on concept_map for insert with check (true);
create policy "concept_map_service_update" on concept_map for update using (true);

-- Sessions — service role only (server manages them)
create policy "sessions_service_all" on sessions for all using (true);
