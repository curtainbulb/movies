-- Shared, non-personal cache of poster lookups (Wikipedia/TMDB results keyed by a normalized
-- title+year+provider identity, the same LedgerCore.identity() used client-side for film
-- matching). Any authenticated user may read and contribute entries; there is no per-user data
-- here, so sharing the cache across accounts is safe and is the point: once one signed-in user
-- has looked up a poster, every other signed-in user avoids re-querying Wikipedia/TMDB for the
-- same title, which is what actually avoids their IP-based rate limits.
create function public.nightreel_artwork_entry_valid(entry jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(entry) is distinct from 'object' then return false; end if;
  if entry ? 'posterUrl' and (
    jsonb_typeof(entry->'posterUrl') is distinct from 'string'
    or length(entry->>'posterUrl') > 1024
    or entry->>'posterUrl' !~ '^https://'
  ) then return false; end if;
  if entry ? 'sourceUrl' and (
    jsonb_typeof(entry->'sourceUrl') is distinct from 'string'
    or length(entry->>'sourceUrl') > 1024
    or entry->>'sourceUrl' !~ '^https://'
  ) then return false; end if;
  if entry ? 'source' and (jsonb_typeof(entry->'source') is distinct from 'string' or length(entry->>'source') > 100) then return false; end if;
  if entry ? 'overview' and (jsonb_typeof(entry->'overview') is distinct from 'string' or length(entry->>'overview') > 2000) then return false; end if;
  if octet_length(entry::text) > 8192 then return false; end if;
  return true;
exception when others then return false;
end;
$$;

create table public.nightreel_artwork_cache (
  identity_key text primary key check (length(identity_key) between 1 and 512),
  provider text not null check (provider in ('wikipedia', 'tmdb')),
  match jsonb check (match is null or public.nightreel_artwork_entry_valid(match)),
  fetched_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create index nightreel_artwork_cache_fetched_at_idx on public.nightreel_artwork_cache (fetched_at);

alter table public.nightreel_artwork_cache enable row level security;
revoke all on public.nightreel_artwork_cache from public, anon, authenticated;
grant select on public.nightreel_artwork_cache to authenticated;
create policy "Authenticated users read the shared artwork cache" on public.nightreel_artwork_cache
  for select to authenticated using (true);

-- Writes go through this function rather than direct table grants so a malicious or buggy
-- client cannot overwrite another entry's identity_key/provider pairing or inject a payload
-- the validity check would reject; it also lets us refresh stale entries without granting
-- UPDATE broadly (a write only replaces an entry already older than one day, so one user
-- cannot repeatedly clobber another's fresh lookup).
create function public.nightreel_upsert_artwork(key text, provider_name text, match_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if key is null or length(key) < 1 or length(key) > 512 then
    raise exception 'invalid identity key' using errcode = '22023';
  end if;
  if provider_name not in ('wikipedia', 'tmdb') then
    raise exception 'invalid provider' using errcode = '22023';
  end if;
  if match_data is not null and not public.nightreel_artwork_entry_valid(match_data) then
    raise exception 'invalid artwork entry' using errcode = '22023';
  end if;
  insert into public.nightreel_artwork_cache as a (identity_key, provider, match, updated_by)
  values (key, provider_name, match_data, auth.uid())
  on conflict (identity_key) do update
    set match = excluded.match, fetched_at = now(), updated_by = excluded.updated_by, provider = excluded.provider
    where a.fetched_at < now() - interval '1 day';
end;
$$;
revoke all on function public.nightreel_upsert_artwork(text, text, jsonb) from public, anon;
grant execute on function public.nightreel_upsert_artwork(text, text, jsonb) to authenticated;
