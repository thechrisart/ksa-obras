-- KSA Grand Construction · Cadastro com aprovação
-- Cole tudo no Supabase: SQL Editor → New query → Run. Pode rodar mais de uma vez.
-- Quem se cadastra pelo site fica "pendente" e só vê as obras depois que um administrador aprovar.

create table if not exists public.members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text,
  role text not null default 'pending' check (role in ('pending', 'member', 'admin', 'blocked')),
  created_at timestamptz not null default now()
);

-- Contas que já existiam (criadas por você no painel) viram administradoras.
insert into public.members (user_id, email, name, role)
select id, email, coalesce(raw_user_meta_data->>'name', ''), 'admin' from auth.users
on conflict (user_id) do nothing;

-- Toda conta nova entra como pendente.
create or replace function public.handle_new_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.members (user_id, email, name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', ''), 'pending')
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_member();

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and role in ('member', 'admin'));
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and role = 'admin');
$$;

alter table public.members enable row level security;
drop policy if exists "ve proprio ou admin" on public.members;
create policy "ve proprio ou admin" on public.members for select to authenticated using (user_id = auth.uid() or public.is_admin());
drop policy if exists "admin altera" on public.members;
create policy "admin altera" on public.members for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin remove" on public.members;
create policy "admin remove" on public.members for delete to authenticated using (public.is_admin());

-- Obras, fotos e arquivos: só membros aprovados.
drop policy if exists "equipe projects" on public.projects;
create policy "equipe projects" on public.projects for all to authenticated using (public.is_member()) with check (public.is_member());
drop policy if exists "equipe media" on public.media;
create policy "equipe media" on public.media for all to authenticated using (public.is_member()) with check (public.is_member());

drop policy if exists "equipe le obras" on storage.objects;
create policy "equipe le obras" on storage.objects for select to authenticated using (bucket_id = 'obras' and public.is_member());
drop policy if exists "equipe envia obras" on storage.objects;
create policy "equipe envia obras" on storage.objects for insert to authenticated with check (bucket_id = 'obras' and public.is_member());
drop policy if exists "equipe altera obras" on storage.objects;
create policy "equipe altera obras" on storage.objects for update to authenticated using (bucket_id = 'obras' and public.is_member());
drop policy if exists "equipe apaga obras" on storage.objects;
create policy "equipe apaga obras" on storage.objects for delete to authenticated using (bucket_id = 'obras' and public.is_member());
