-- KSA Grand Construction · Empresas contratantes
-- Cole tudo no Supabase: SQL Editor → New query → Run. Pode rodar mais de uma vez.

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  phone text,
  email text,
  tax_id text,
  address text,
  created_at timestamptz not null default now()
);

alter table public.projects add column if not exists company_id uuid references public.companies(id) on delete set null;

alter table public.companies enable row level security;
drop policy if exists "equipe companies" on public.companies;
create policy "equipe companies" on public.companies for all to authenticated using (true) with check (true);
