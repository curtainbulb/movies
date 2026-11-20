-- A versioned document preserves the existing application model and stable IDs.
-- Integrity checks keep collection, film and viewing-path relationships valid.
create function public.nightreel_archive_valid(document jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(document) is distinct from 'object'
     or document->>'schema' is distinct from 'nightreel-archive'
     or document->>'version' is distinct from '3'
     or jsonb_typeof(document->'collections') is distinct from 'array'
     or jsonb_typeof(document->'paths') is distinct from 'array'
     or jsonb_typeof(document->'savedViews') is distinct from 'array'
     or jsonb_typeof(document->'profiles') is distinct from 'array'
     or jsonb_typeof(document->'feedback') is distinct from 'array'
     or jsonb_typeof(document->'cloudSources') is distinct from 'array'
     or octet_length(document::text) > 33554432 then return false; end if;
  if exists (
    select 1 from jsonb_array_elements(document->'collections') as c(item)
    where jsonb_typeof(c.item) is distinct from 'object'
       or jsonb_typeof(c.item->'id') is distinct from 'string'
       or coalesce(c.item->>'id', '') = ''
       or jsonb_typeof(c.item->'name') is distinct from 'string'
       or jsonb_typeof(c.item->'films') is distinct from 'array'
  ) then return false; end if;
  if exists (
    select 1 from jsonb_array_elements(document->'collections') as c(item)
    group by c.item->>'id' having count(*) > 1
  ) then return false; end if;
  if exists (
    select 1 from jsonb_array_elements(document->'collections') as c(item)
    cross join lateral jsonb_array_elements(c.item->'films') as f(item)
    where jsonb_typeof(f.item) is distinct from 'object'
       or jsonb_typeof(f.item->'id') is distinct from 'string'
       or coalesce(f.item->>'id', '') = ''
       or jsonb_typeof(f.item->'title') is distinct from 'string'
       or length(btrim(f.item->>'title')) not between 1 and 1000
       or jsonb_typeof(f.item->'watched') is distinct from 'boolean'
       or jsonb_typeof(f.item->'rating') is distinct from 'number'
       or coalesce(f.item->>'rating', '') !~ '^[0-5]$'
       or jsonb_typeof(f.item->'note') is distinct from 'string'
       or jsonb_typeof(f.item->'genres') is distinct from 'array'
  ) then return false; end if;
  if exists (
    select 1 from jsonb_array_elements(document->'collections') as c(item)
    cross join lateral jsonb_array_elements(c.item->'films') as f(item)
    group by f.item->>'id' having count(*) > 1
  ) then return false; end if;
  if exists (
    select 1 from jsonb_array_elements(document->'paths') as p(item)
    where jsonb_typeof(p.item->'id') is distinct from 'string'
       or coalesce(p.item->>'id', '') = ''
       or jsonb_typeof(p.item->'filmIds') is distinct from 'array'
       or not exists (select 1 from jsonb_array_elements(document->'collections') as c(item)
                      where c.item->>'id' = p.item->>'collectionId')
  ) then return false; end if;
  if exists (
    select 1 from jsonb_array_elements(document->'paths') as p(item)
    group by p.item->>'id' having count(*) > 1
  ) then return false; end if;
  if exists (
    select 1 from jsonb_array_elements(document->'paths') as p(item)
    cross join lateral jsonb_array_elements(p.item->'filmIds') as path_film(item)
    where jsonb_typeof(path_film.item) is distinct from 'string'
       or not exists (
         select 1 from jsonb_array_elements(document->'collections') as c(item)
         cross join lateral jsonb_array_elements(c.item->'films') as f(item)
         where c.item->>'id' = p.item->>'collectionId' and f.item->>'id' = path_film.item #>> '{}'
       )
  ) then return false; end if;
  return true;
exception when others then return false;
end;
$$;

create table public.nightreel_archives (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  archive jsonb not null check (public.nightreel_archive_valid(archive)),
  updated_at timestamptz not null default now()
);

alter table public.nightreel_archives enable row level security;
revoke all on public.nightreel_archives from public, anon, authenticated;
grant select on public.nightreel_archives to authenticated;
create policy "Users read their own archive" on public.nightreel_archives
  for select to authenticated using ((select auth.uid()) = user_id);

-- The caller cannot supply an owner. The conditional write serializes devices.
create function public.nightreel_commit_archive(expected_revision bigint, document jsonb)
returns table (revision bigint, archive jsonb, updated_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
begin
  if owner_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if expected_revision is null or expected_revision < 0 then
    raise exception 'invalid revision' using errcode = '22023';
  end if;
  if expected_revision = 0 then
    return query
      insert into public.nightreel_archives as a (user_id, archive)
      values (owner_id, document)
      on conflict (user_id) do nothing
      returning a.revision, a.archive, a.updated_at;
  else
    return query
      update public.nightreel_archives as a
      set archive = document, revision = a.revision + 1, updated_at = now()
      where a.user_id = owner_id and a.revision = expected_revision
      returning a.revision, a.archive, a.updated_at;
  end if;
  if not found then
    raise exception 'archive revision conflict' using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function public.nightreel_commit_archive(bigint, jsonb) from public, anon;
grant execute on function public.nightreel_commit_archive(bigint, jsonb) to authenticated;
