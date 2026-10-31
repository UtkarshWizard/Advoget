-- =============================================================================
-- Advoget V0: Initial Database Schema, Hybrid Search Functions, and RLS
-- Requires pgvector 0.7+ for halfvec(1024) support.
--Verify version with: select extversion from pg_extension where extname = 'vector';
-- =============================================================================

create extension if not exists vector;

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  audience text not null default 'citizen' check (audience in ('citizen', 'lawyer')),
  created_at timestamptz default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  title text,
  created_at timestamptz default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  scope_label text,                     -- legal | not_legal | unclear (set on user messages)
  sources jsonb not null default '[]',  -- set on assistant messages
  created_at timestamptz default now()
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  conversation_id uuid references public.conversations on delete set null,
  filename text not null,
  storage_path text not null,
  size_bytes int,
  page_count int,
  text_page_count int,
  status text not null default 'uploaded'
    check (status in ('uploaded', 'processing', 'ready', 'rejected', 'failed')),
  status_detail text,
  created_at timestamptz default now()
);

create table if not exists public.document_chunks (
  id bigserial primary key,
  document_id uuid not null references public.documents on delete cascade,
  user_id uuid not null,
  chunk_index int not null,
  page_start int not null,
  page_end int not null,
  content text not null,
  meta jsonb not null default '{}',     -- reserved for V1 (bbox, OCR confidence)
  embedding halfvec(1024),
  embedding_model text,
  tsv tsvector generated always as (to_tsvector('simple', content)) stored
);

create table if not exists public.statute_chunks (
  id bigserial primary key,
  act text not null,
  act_short text not null,              -- e.g. 'Bharatiya Nagarik Suraksha Sanhita', 'BNSS'
  section text,
  heading text,
  content text not null,
  source_url text,
  as_of date,
  embedding halfvec(1024),
  embedding_model text,
  tsv tsvector generated always as
    (to_tsvector('simple', coalesce(heading, '') || ' ' || content)) stored
);

create table if not exists public.usage_daily (
  user_id uuid not null,
  day date not null,
  messages int not null default 0,
  llm_calls int not null default 0,
  web_searches int not null default 0,
  primary key (user_id, day)
);

-- -----------------------------------------------------------------------------
-- 2. Indexes
-- -----------------------------------------------------------------------------

create index if not exists idx_document_chunks_embedding
  on public.document_chunks using hnsw (embedding halfvec_cosine_ops);

create index if not exists idx_document_chunks_tsv
  on public.document_chunks using gin (tsv);

create index if not exists idx_document_chunks_user_doc
  on public.document_chunks (user_id, document_id);

create index if not exists idx_statute_chunks_embedding
  on public.statute_chunks using hnsw (embedding halfvec_cosine_ops);

create index if not exists idx_statute_chunks_tsv
  on public.statute_chunks using gin (tsv);

create index if not exists idx_statute_chunks_act_section
  on public.statute_chunks (act_short, section);

create index if not exists idx_conversations_user_created
  on public.conversations (user_id, created_at desc);

create index if not exists idx_messages_conversation_created
  on public.messages (conversation_id, created_at asc);

-- -----------------------------------------------------------------------------
-- 3. Auto-create Profile Trigger on Auth Signup
-- -----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, audience)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ),
    'citizen'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- -----------------------------------------------------------------------------
-- 4. Hybrid Retrieval Functions (Vector + Keyword)
-- Every document query strictly filters by p_user_id for tenant isolation.
-- -----------------------------------------------------------------------------

create or replace function public.match_document_chunks(
  query_embedding halfvec(1024),
  p_user_id uuid,
  p_document_ids uuid[] default null,
  match_count int default 5
)
returns table (
  id bigint,
  document_id uuid,
  filename text,
  chunk_index int,
  page_start int,
  page_end int,
  content text,
  similarity float
)
language sql
stable
as $$
  select
    dc.id,
    dc.document_id,
    d.filename,
    dc.chunk_index,
    dc.page_start,
    dc.page_end,
    dc.content,
    1 - (dc.embedding <=> query_embedding) as similarity
  from public.document_chunks dc
  join public.documents d on d.id = dc.document_id
  where dc.user_id = p_user_id
    and d.user_id = p_user_id
    and dc.embedding is not null
    and (
      p_document_ids is null
      or cardinality(p_document_ids) = 0
      or dc.document_id = any(p_document_ids)
    )
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function public.keyword_document_chunks(
  q text,
  p_user_id uuid,
  p_document_ids uuid[] default null,
  match_count int default 5
)
returns table (
  id bigint,
  document_id uuid,
  filename text,
  chunk_index int,
  page_start int,
  page_end int,
  content text,
  rank float
)
language sql
stable
as $$
  select
    dc.id,
    dc.document_id,
    d.filename,
    dc.chunk_index,
    dc.page_start,
    dc.page_end,
    dc.content,
    ts_rank(dc.tsv, websearch_to_tsquery('simple', q))::float as rank
  from public.document_chunks dc
  join public.documents d on d.id = dc.document_id
  where dc.user_id = p_user_id
    and d.user_id = p_user_id
    and dc.tsv @@ websearch_to_tsquery('simple', q)
    and (
      p_document_ids is null
      or cardinality(p_document_ids) = 0
      or dc.document_id = any(p_document_ids)
    )
  order by rank desc
  limit match_count;
$$;

create or replace function public.match_statute_chunks(
  query_embedding halfvec(1024),
  p_act_short text default null,
  match_count int default 5
)
returns table (
  id bigint,
  act text,
  act_short text,
  section text,
  heading text,
  content text,
  source_url text,
  as_of date,
  similarity float
)
language sql
stable
as $$
  select
    sc.id,
    sc.act,
    sc.act_short,
    sc.section,
    sc.heading,
    sc.content,
    sc.source_url,
    sc.as_of,
    1 - (sc.embedding <=> query_embedding) as similarity
  from public.statute_chunks sc
  where sc.embedding is not null
    and (p_act_short is null or lower(sc.act_short) = lower(p_act_short))
  order by sc.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function public.keyword_statute_chunks(
  q text,
  p_act_short text default null,
  match_count int default 5
)
returns table (
  id bigint,
  act text,
  act_short text,
  section text,
  heading text,
  content text,
  source_url text,
  as_of date,
  rank float
)
language sql
stable
as $$
  select
    sc.id,
    sc.act,
    sc.act_short,
    sc.section,
    sc.heading,
    sc.content,
    sc.source_url,
    sc.as_of,
    ts_rank(sc.tsv, websearch_to_tsquery('simple', q))::float as rank
  from public.statute_chunks sc
  where sc.tsv @@ websearch_to_tsquery('simple', q)
    and (p_act_short is null or lower(sc.act_short) = lower(p_act_short))
  order by rank desc
  limit match_count;
$$;

-- -----------------------------------------------------------------------------
-- 5. Row Level Security (RLS)
-- -----------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.statute_chunks enable row level security;
alter table public.usage_daily enable row level security;

-- profiles: owner-only (auth.uid() = id)
drop policy if exists "profiles_owner_select" on public.profiles;
create policy "profiles_owner_select" on public.profiles
  for select to authenticated using (auth.uid() = id);

drop policy if exists "profiles_owner_insert" on public.profiles;
create policy "profiles_owner_insert" on public.profiles
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists "profiles_owner_update" on public.profiles;
create policy "profiles_owner_update" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "profiles_owner_delete" on public.profiles;
create policy "profiles_owner_delete" on public.profiles
  for delete to authenticated using (auth.uid() = id);

-- conversations: owner-only (auth.uid() = user_id)
drop policy if exists "conversations_owner_all" on public.conversations;
create policy "conversations_owner_all" on public.conversations
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- messages: owner-only (auth.uid() = user_id)
drop policy if exists "messages_owner_all" on public.messages;
create policy "messages_owner_all" on public.messages
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- documents: owner-only (auth.uid() = user_id)
drop policy if exists "documents_owner_all" on public.documents;
create policy "documents_owner_all" on public.documents
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- document_chunks: owner-only (auth.uid() = user_id)
drop policy if exists "document_chunks_owner_all" on public.document_chunks;
create policy "document_chunks_owner_all" on public.document_chunks
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- usage_daily: owner-only (auth.uid() = user_id)
drop policy if exists "usage_daily_owner_all" on public.usage_daily;
create policy "usage_daily_owner_all" on public.usage_daily
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- statute_chunks: read-only for authenticated users
drop policy if exists "statute_chunks_authenticated_read" on public.statute_chunks;
create policy "statute_chunks_authenticated_read" on public.statute_chunks
  for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- 6. Private Storage Bucket ('documents') & Folder Isolation Policies
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 20971520, array['application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = 20971520,
      allowed_mime_types = array['application/pdf'];

drop policy if exists "documents_bucket_owner_select" on storage.objects;
create policy "documents_bucket_owner_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "documents_bucket_owner_insert" on storage.objects;
create policy "documents_bucket_owner_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "documents_bucket_owner_update" on storage.objects;
create policy "documents_bucket_owner_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "documents_bucket_owner_delete" on storage.objects;
create policy "documents_bucket_owner_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text);

