-- KSA Grand Construction · Diário de reformas
-- Cole tudo no Supabase: SQL Editor → New query → Run. Pode rodar mais de uma vez.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  client text not null,
  city text not null,
  type text,
  address text,
  contact text,
  phone text,
  email text,
  start_date date,
  status text not null default 'and',
  notes text,
  media_count int not null default 0,
  cover_path text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.media (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  path text not null,
  kind text not null default 'image',
  stage text not null default 'durante',
  caption text default '',
  name text,
  size bigint,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists media_project_idx on public.media(project_id, created_at);

-- Só quem faz login (contas criadas por você) lê e grava.
alter table public.projects enable row level security;
alter table public.media enable row level security;

drop policy if exists "equipe projects" on public.projects;
create policy "equipe projects" on public.projects for all to authenticated using (true) with check (true);
drop policy if exists "equipe media" on public.media;
create policy "equipe media" on public.media for all to authenticated using (true) with check (true);

-- Fotos e vídeos em bucket privado (limite de 50 MB por arquivo).
insert into storage.buckets (id, name, public, file_size_limit)
values ('obras', 'obras', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists "equipe le obras" on storage.objects;
create policy "equipe le obras" on storage.objects for select to authenticated using (bucket_id = 'obras');
drop policy if exists "equipe envia obras" on storage.objects;
create policy "equipe envia obras" on storage.objects for insert to authenticated with check (bucket_id = 'obras');
drop policy if exists "equipe altera obras" on storage.objects;
create policy "equipe altera obras" on storage.objects for update to authenticated using (bucket_id = 'obras');
drop policy if exists "equipe apaga obras" on storage.objects;
create policy "equipe apaga obras" on storage.objects for delete to authenticated using (bucket_id = 'obras');

-- Atualização ao vivo entre celulares.
do $$ begin
  alter publication supabase_realtime add table public.projects;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.media;
exception when duplicate_object then null; end $$;
