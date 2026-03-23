-- ============================================================
-- SageStack — Analytics Schema (run after supabase-schema.sql)
-- ============================================================

-- ============================================================
-- CHAT LOGS
-- Every user message + response, auto-tagged with subjects
-- ============================================================
create table if not exists chat_logs (
  id                uuid primary key default gen_random_uuid(),
  session_id        text references sessions(id) on delete set null,
  user_message      text not null,
  assistant_response text,
  mode              text default 'quick',             -- quick | deep
  subjects          jsonb default '[]',               -- auto-extracted from retrieved chunks
  themes            jsonb default '[]',               -- themes from retrieved chunks
  sources_used      jsonb default '[]',               -- which source files were cited
  chunks_used       jsonb default '[]',               -- chunk summaries that were retrieved
  response_tokens   integer,                          -- token count for cost tracking
  created_at        timestamptz default now()
);

create index if not exists chat_logs_session_idx on chat_logs(session_id);
create index if not exists chat_logs_created_idx on chat_logs(created_at desc);
create index if not exists chat_logs_subjects_idx on chat_logs using gin(subjects);
create index if not exists chat_logs_themes_idx on chat_logs using gin(themes);

-- ============================================================
-- CHUNK ANALYTICS
-- Tracks which chunks get retrieved most — drives Sonnet upgrade queue
-- ============================================================
create table if not exists chunk_analytics (
  id              uuid primary key default gen_random_uuid(),
  source          text not null,
  chunk_index     integer not null,
  query_count     integer default 1,
  sonnet_queued   boolean default false,    -- flagged for deep Sonnet re-analysis
  sonnet_done     boolean default false,    -- upgraded to Sonnet analysis
  last_queried_at timestamptz default now(),
  created_at      timestamptz default now(),
  unique(source, chunk_index)
);

create index if not exists chunk_analytics_count_idx on chunk_analytics(query_count desc);
create index if not exists chunk_analytics_queue_idx on chunk_analytics(sonnet_queued) where sonnet_queued = true;

-- ============================================================
-- RLS
-- ============================================================
alter table chat_logs enable row level security;
alter table chunk_analytics enable row level security;

create policy "chat_logs_service_all" on chat_logs for all using (true);
create policy "chunk_analytics_service_all" on chunk_analytics for all using (true);

-- ============================================================
-- HELPER FUNCTION: increment_chunk_query
-- Called on every chat to track which chunks get used most
-- ============================================================
create or replace function increment_chunk_query(p_source text, p_chunk_index integer)
returns void as $$
begin
  insert into chunk_analytics (source, chunk_index, query_count, last_queried_at)
  values (p_source, p_chunk_index, 1, now())
  on conflict (source, chunk_index)
  do update set
    query_count = chunk_analytics.query_count + 1,
    last_queried_at = now();
end;
$$ language plpgsql;

-- ============================================================
-- SCHEDULED FUNCTION: flag_chunks_for_deep_analysis
-- Run on a schedule (daily/weekly) to flag hot chunks for
-- Sonnet re-analysis. Any chunk queried 5+ times gets flagged.
-- ============================================================
create or replace function flag_chunks_for_deep_analysis()
returns jsonb as $$
declare
  flagged_count integer;
begin
  update chunk_analytics
  set sonnet_queued = true
  where query_count >= 5
    and sonnet_queued = false
    and sonnet_done = false;

  get diagnostics flagged_count = row_count;

  -- Return summary for logging
  return jsonb_build_object(
    'flagged', flagged_count,
    'total_queued', (select count(*) from chunk_analytics where sonnet_queued = true and sonnet_done = false),
    'ran_at', now()
  );
end;
$$ language plpgsql;

-- ============================================================
-- VIEW: usage_summary
-- Quick dashboard view of what topics users ask about most
-- ============================================================
create or replace view usage_summary as
select
  s.value::text as subject,
  count(*)      as query_count,
  max(cl.created_at) as last_seen
from chat_logs cl,
  jsonb_array_elements(cl.subjects) as s
group by s.value
order by query_count desc;

-- ============================================================
-- VIEW: hot_chunks
-- Chunks queried most — candidates for Sonnet upgrade
-- ============================================================
create or replace view hot_chunks as
select
  ca.source,
  ca.chunk_index,
  ca.query_count,
  ca.sonnet_queued,
  ca.sonnet_done,
  ca.last_queried_at
from chunk_analytics ca
order by ca.query_count desc;
