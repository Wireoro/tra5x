-- Tra5x migration 2: record every daily statistic.
--   * player_history now holds ALL players (with rank + tribe), not just the top N
--   * snapshot_breakdowns: queryable per-day distributions (regions, distance rings, quadrants, buckets)
--   * snapshots gets the concentration metrics as real columns
--   * events: change log (village founded / conquered / abandoned, players new / departed,
--     alliance joined / left / switched / created / disbanded)
--   * prune_history() + storage_stats() to keep an eye on database size
-- Everything stays private: RLS on, no grants for the public API roles.

-- 1) Snapshot-level concentration metrics --------------------------------------------------------
alter table public.snapshots
  add column if not exists top10_share  numeric(7, 6),
  add column if not exists top100_share numeric(7, 6);

-- 2) Full player history --------------------------------------------------------------------------
alter table public.player_history
  add column if not exists rank  integer,
  add column if not exists tribe smallint;

-- 3) Per-day breakdowns (long format: one row per kind + bucket) ---------------------------------
create table public.snapshot_breakdowns (
  snapshot_id bigint  not null references public.snapshots (id) on delete cascade,
  kind        text    not null check (kind in ('pop_bucket', 'village_bucket', 'quadrant', 'ring', 'region')),
  key         text    not null,
  lo          numeric,
  hi          numeric,
  players     integer not null default 0,
  villages    integer not null default 0,
  population  bigint  not null default 0,
  primary key (snapshot_id, kind, key)
);

-- 4) Change log ----------------------------------------------------------------------------------
-- Column meaning:  player_* / alliance_* = the subject (new owner, new alliance);
--                  from_player_* / from_alliance_* = the previous owner / previous alliance.
create table public.events (
  id                bigint generated always as identity primary key,
  world             text    not null,
  snapshot_id       bigint  not null references public.snapshots (id) on delete cascade,
  kind              text    not null check (kind in (
                      'village_founded', 'village_conquered', 'village_abandoned',
                      'player_new', 'player_departed',
                      'alliance_joined', 'alliance_left', 'alliance_switched',
                      'alliance_created', 'alliance_disbanded')),
  x                 integer,
  y                 integer,
  village_id        bigint,
  village_name      text,
  player_id         bigint,
  player_name       text,
  from_player_id    bigint,
  from_player_name  text,
  alliance_id       bigint,
  alliance_tag      text,
  from_alliance_id  bigint,
  from_alliance_tag text,
  population        bigint
);
create index events_world_snapshot_idx on public.events (world, snapshot_id desc, id);
create index events_world_kind_idx     on public.events (world, kind, snapshot_id desc);
create index events_player_idx         on public.events (player_id)        where player_id is not null;
create index events_from_player_idx    on public.events (from_player_id)   where from_player_id is not null;
create index events_alliance_idx       on public.events (alliance_id)      where alliance_id is not null;
create index events_from_alliance_idx  on public.events (from_alliance_id) where from_alliance_id is not null;
create index events_tile_idx           on public.events (x, y)             where x is not null;

-- 5) Lock down ------------------------------------------------------------------------------------
alter table public.snapshot_breakdowns enable row level security;
alter table public.events              enable row level security;
revoke all on public.snapshot_breakdowns, public.events from anon, authenticated;

-- 6) Ingest: same contract as before, now recording everything --------------------------------------
-- Payload additions: p.breakdowns[], p.village_events[]; history_top_players = 0 means "all players".
create or replace function public.ingest_snapshot(p jsonb)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_world  text    := p->>'world';
  v_id     bigint;
  v_new    integer := 0;
  v_gone   integer := 0;
  v_top_n  integer := coalesce((p->>'history_top_players')::integer, 0);
  t        jsonb   := p->'totals';
  v_conc   jsonb   := p->'meta'->'concentration';
  v_base   boolean;
begin
  insert into snapshots (
    world, source_url, content_hash, etag, source_last_modified,
    tiles, players, alliances, villages, natar_villages, population,
    capitals, cities, harbors, players_in_alliance, top10_share, top100_share, meta
  ) values (
    v_world, p->>'source_url', p->>'content_hash', p->>'etag',
    nullif(p->>'source_last_modified', '')::timestamptz,
    coalesce((t->>'tiles')::int, 0), coalesce((t->>'players')::int, 0), coalesce((t->>'alliances')::int, 0),
    coalesce((t->>'villages')::int, 0), coalesce((t->>'natar_villages')::int, 0), coalesce((t->>'population')::bigint, 0),
    coalesce((t->>'capitals')::int, 0), coalesce((t->>'cities')::int, 0), coalesce((t->>'harbors')::int, 0),
    coalesce((t->>'players_in_alliance')::int, 0),
    nullif(v_conc->>'top10', '')::numeric, nullif(v_conc->>'top100', '')::numeric,
    coalesce(p->'meta', '{}'::jsonb)
  )
  on conflict (world, content_hash) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from snapshots where world = v_world and content_hash = p->>'content_hash';
    return v_id;  -- identical content already stored
  end if;

  -- A change log only makes sense relative to an existing dataset; the very first snapshot has no baseline.
  v_base := exists (select 1 from snapshots where world = v_world and id <> v_id);

  insert into tribe_stats (snapshot_id, tribe, players, villages, population)
  select v_id, x.tribe, x.players, x.villages, x.population
  from jsonb_to_recordset(p->'tribes') as x(tribe smallint, players int, villages int, population bigint);

  insert into snapshot_breakdowns (snapshot_id, kind, key, lo, hi, players, villages, population)
  select v_id, b.kind, b.key, b.lo, b.hi, coalesce(b.players, 0), coalesce(b.villages, 0), coalesce(b.population, 0)
  from jsonb_to_recordset(coalesce(p->'breakdowns', '[]'::jsonb))
       as b(kind text, key text, lo numeric, hi numeric, players int, villages int, population bigint)
  on conflict do nothing;

  -- Change log: compare the incoming players / alliances with the current tables BEFORE they are overwritten.
  if v_base then
    with inc as materialized (
      select * from jsonb_to_recordset(p->'players')
        as x(id bigint, name text, alliance_id bigint, alliance_tag text, population int)
    )
    insert into events (world, snapshot_id, kind, player_id, player_name, alliance_id, alliance_tag,
                        from_alliance_id, from_alliance_tag, population)
    select v_world, v_id,
           case when pl.id is null              then 'player_new'
                when pl.alliance_id is null     then 'alliance_joined'
                when i.alliance_id is null      then 'alliance_left'
                else 'alliance_switched' end,
           i.id, i.name, i.alliance_id, i.alliance_tag, pl.alliance_id, pl.alliance_tag, i.population
    from inc i
    left join players pl on pl.world = v_world and pl.id = i.id
    where pl.id is null or pl.alliance_id is distinct from i.alliance_id;

    with inc as materialized (
      select x.id from jsonb_to_recordset(p->'players') as x(id bigint)
    )
    insert into events (world, snapshot_id, kind, player_id, player_name, alliance_id, alliance_tag, population)
    select v_world, v_id, 'player_departed', pl.id, pl.name, pl.alliance_id, pl.alliance_tag, pl.population
    from players pl
    left join inc i on i.id = pl.id
    where pl.world = v_world and i.id is null;

    with inc as materialized (
      select x.id, x.tag, x.population from jsonb_to_recordset(p->'alliances') as x(id bigint, tag text, population bigint)
    )
    insert into events (world, snapshot_id, kind, alliance_id, alliance_tag, population)
    select v_world, v_id, 'alliance_created', i.id, i.tag, i.population
    from inc i
    left join alliances al on al.world = v_world and al.id = i.id
    where al.id is null;

    with inc as materialized (
      select x.id from jsonb_to_recordset(p->'alliances') as x(id bigint)
    )
    insert into events (world, snapshot_id, kind, alliance_id, alliance_tag, population)
    select v_world, v_id, 'alliance_disbanded', al.id, al.tag, al.population
    from alliances al
    left join inc i on i.id = al.id
    where al.world = v_world and i.id is null;
  end if;

  -- Village-level changes (diffed by the app against the previous map).
  insert into events (world, snapshot_id, kind, x, y, village_id, village_name,
                      player_id, player_name, from_player_id, from_player_name,
                      alliance_id, alliance_tag, from_alliance_id, from_alliance_tag, population)
  select v_world, v_id, e.kind, e.x, e.y, e.village_id, e.village_name,
         e.player_id, e.player_name, e.from_player_id, e.from_player_name,
         e.alliance_id, e.alliance_tag, e.from_alliance_id, e.from_alliance_tag, e.population
  from jsonb_to_recordset(coalesce(p->'village_events', '[]'::jsonb)) as e(
         kind text, x int, y int, village_id bigint, village_name text,
         player_id bigint, player_name text, from_player_id bigint, from_player_name text,
         alliance_id bigint, alliance_tag text, from_alliance_id bigint, from_alliance_tag text, population bigint);

  -- Players: upsert current state, keep previous population for 24h deltas.
  with up as (
    insert into players as pl (
      world, id, name, tribe, alliance_id, alliance_tag, villages, population,
      rank, capital_x, capital_y, victory_points, first_snapshot_id, last_snapshot_id
    )
    select v_world, x.id, x.name, x.tribe, x.alliance_id, x.alliance_tag, x.villages, x.population,
           (row_number() over (order by x.population desc, x.id))::int,
           x.capital_x, x.capital_y, x.victory_points, v_id, v_id
    from jsonb_to_recordset(p->'players') as x(
      id bigint, name text, tribe smallint, alliance_id bigint, alliance_tag text,
      villages int, population int, capital_x int, capital_y int, victory_points int)
    on conflict (world, id) do update set
      name = excluded.name,
      tribe = excluded.tribe,
      alliance_id = excluded.alliance_id,
      alliance_tag = excluded.alliance_tag,
      villages = excluded.villages,
      prev_population = pl.population,
      population = excluded.population,
      rank = excluded.rank,
      capital_x = excluded.capital_x,
      capital_y = excluded.capital_y,
      victory_points = excluded.victory_points,
      last_snapshot_id = excluded.last_snapshot_id
    returning (xmax = 0) as inserted
  )
  select count(*) filter (where inserted) into v_new from up;

  if not v_base then
    v_new := 0;
  end if;

  with del as (
    delete from players where world = v_world and last_snapshot_id <> v_id returning 1
  )
  select count(*) into v_gone from del;

  -- Alliances
  insert into alliances as al (world, id, tag, members, villages, population, rank, last_snapshot_id)
  select v_world, x.id, x.tag, x.members, x.villages, x.population,
         (row_number() over (order by x.population desc, x.id))::int, v_id
  from jsonb_to_recordset(p->'alliances') as x(id bigint, tag text, members int, villages int, population bigint)
  on conflict (world, id) do update set
    tag = excluded.tag,
    members = excluded.members,
    villages = excluded.villages,
    prev_population = al.population,
    population = excluded.population,
    rank = excluded.rank,
    last_snapshot_id = excluded.last_snapshot_id;

  delete from alliances where world = v_world and last_snapshot_id <> v_id;

  insert into alliance_history (snapshot_id, alliance_id, tag, members, villages, population)
  select v_id, x.id, x.tag, x.members, x.villages, x.population
  from jsonb_to_recordset(p->'alliances') as x(id bigint, tag text, members int, villages int, population bigint);

  -- Per-day history of every player (v_top_n > 0 limits it to the top N, e.g. on very small database plans).
  insert into player_history (snapshot_id, player_id, population, villages, alliance_id, tribe, rank)
  select v_id, x.id, x.population, x.villages, x.alliance_id, x.tribe,
         (row_number() over (order by x.population desc, x.id))::int
  from jsonb_to_recordset(p->'players') as x(id bigint, population int, villages int, alliance_id bigint, tribe smallint)
  order by x.population desc, x.id
  limit (case when v_top_n > 0 then v_top_n end);

  update snapshots set new_players = v_new, departed_players = v_gone where id = v_id;

  return v_id;
end;
$$;

revoke execute on function public.ingest_snapshot(jsonb) from public, anon, authenticated;
grant  execute on function public.ingest_snapshot(jsonb) to service_role;

-- 7) Housekeeping ----------------------------------------------------------------------------------
-- Deletes snapshots (and, by cascade, all their history rows and events) older than p_keep_days.
-- The most recent snapshot is always kept. p_keep_days <= 0 disables pruning.
create or replace function public.prune_history(p_world text, p_keep_days integer)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_n integer := 0;
begin
  if p_keep_days is null or p_keep_days <= 0 then
    return 0;
  end if;
  with newest as (
    select id from snapshots where world = p_world order by taken_at desc, id desc limit 1
  ), del as (
    delete from snapshots s
    where s.world = p_world
      and s.taken_at < now() - make_interval(days => p_keep_days)
      and s.id not in (select id from newest)
    returning 1
  )
  select count(*) into v_n from del;
  return v_n;
end;
$$;

-- Database size + per-table footprint (rows are planner estimates).
create or replace function public.storage_stats()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'tables', coalesce((
      select jsonb_object_agg(c.relname, jsonb_build_object(
               'bytes', pg_total_relation_size(c.oid),
               'rows',  greatest(c.reltuples, 0)::bigint))
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    ), '{}'::jsonb)
  );
$$;

revoke execute on function public.prune_history(text, integer) from public, anon, authenticated;
revoke execute on function public.storage_stats()              from public, anon, authenticated;
grant  execute on function public.prune_history(text, integer) to service_role;
grant  execute on function public.storage_stats()              to service_role;
