-- ============================================================
-- SageStack — pgvector Search Function
-- Run in Supabase SQL Editor after enabling vector extension
-- ============================================================

-- NOTE: The chunks table uses vector(1024) for Voyage AI voyage-3
-- Update the schema if you created it with vector(1536)
alter table chunks alter column embedding type vector(1024)
  using embedding::vector(1024);

-- IVFFlat index for fast approximate nearest neighbor search
-- Build after embeddings are populated (not before)
-- create index on chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ============================================================
-- FUNCTION: match_chunks
-- Semantic search via cosine similarity
-- ============================================================
create or replace function match_chunks(
  query_embedding vector(1024),
  match_count     integer default 10
)
returns table (
  id                      uuid,
  source                  text,
  chunk_index             integer,
  text                    text,
  summary                 text,
  concepts                jsonb,
  themes                  jsonb,
  scripture_refs          jsonb,
  philosophical_arguments jsonb,
  cross_text_connections  jsonb,
  difficulty              text,
  origin_context          text,
  similarity              float
)
language sql stable
as $$
  select
    c.id,
    c.source,
    c.chunk_index,
    c.text,
    c.summary,
    c.concepts,
    c.themes,
    c.scripture_refs,
    c.philosophical_arguments,
    c.cross_text_connections,
    c.difficulty,
    c.origin_context,
    1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  where c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
