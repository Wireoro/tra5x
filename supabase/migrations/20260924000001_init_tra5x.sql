-- Tra5x: macro statistics for Travian worlds (built from the public map.sql export).
-- All tables are private (RLS on, no policies): only the server-side service role can read/write.

create table public.snapshots (
  id                   bigint generated always as identity primary key,
  world                text        not null,
  taken_at             timestamptz not null default now(),
  source_url           text,
  content_hash         text        not null,
  etag                 text,
  source_last_modified timestamptz,
  tiles                integer     not null default 0,
  players              integer     not null default 0,
  alliances            integer     not null default 0,
  villages             integer     not null default 0,
  natar_villages       integer     not null default 0,
  population           bigint      not null default 0,
  capitals             integer     not null default 0,
  cities               integer     not null default 0,
  harbors              integer     not null default 0,
  players_in_alliance  integer     not null default 0,
  new_players          integer     not null default 0,
  departed_players     integer     not null default 0,
  meta                 jsonb       not null default '{}'::jsonb
);
create unique index snapshots_world_hash_uidx on public.snapshots (world, content_hash);
create index snapshots_world_taken_idx on public.snapshots (world, taken_at desc);

create table public.tribe_stats (
  snapshot_id bigint   not null references public.snapshots (id) on delete cascade,
  tribe       smallint not null,
  players     integer  not null default 0,
  villages    integer  not null default 0,
  population  bigint   not null default 0,
  primary key (snapshot_id, tribe)
);

create table public.players (
  world            text     not null,
  id               bigint   not null,
  name             text     not null,
  tribe            smallint,
  alliance_id      bigint,
  alliance_tag     text,
  villages         integer  not null default 0,
  population       integer  not null default 0,
  prev_population  integer,
  pop_delta        integer generated always as (population - prev_population) stored,
  rank             integer,
  capital_x        integer,
  capital_y        integer,
  victory_points   integer,
  first_snapshot_id bigint,
  last_snapshot_id  bigint  not null,
  primary key (world, id)
);
create index players_world_rank_idx     on public.players (world, rank);
create index players_world_alliance_idx on public.players (world, alliance_id);
create index players_world_delta_idx    on public.players (world, pop_delta) where pop_delta is not null;
create index players_world_name_idx     on public.players (world, lower(name));

create table public.alliances (
  world            text    not null,
  id               bigint  not null,
  tag              text    not null,
  members          integer not null default 0,
  villages         integer not null default 0,
  population       bigint  not null default 0,
  prev_population  bigint,
  pop_delta        bigint generated always as (population - prev_population) stored,
  rank             integer,
  last_snapshot_id bigint  not null,
  primary key (world, id)
);
create index alliances_world_rank_idx on public.alliances (world, rank);

create table public.player_history (
  snapshot_id bigint  not null references public.snapshots (id) on delete cascade,
  player_id   bigint  not null,
  population  integer not null,
  villages    integer not null,
  alliance_id bigint,
  primary key (snapshot_id, player_id)
);
create index player_history_player_idx on public.player_history (player_id, snapshot_id);

create table public.alliance_history (
  snapshot_id bigint  not null references public.snapshots (id) on delete cascade,
  alliance_id bigint  not null,
  tag         text    not null,
  members     integer not null,
  villages    integer not null,
  population  bigint  not null,
  primary key (snapshot_id, alliance_id)
);
create index alliance_history_alliance_idx on public.alliance_history (alliance_id, snapshot_id);

-- Compact village list for the interactive map (latest snapshot only).
create table public.map_cache (
  world       text primary key,
  snapshot_id bigint      not null references public.snapshots (id) on delete cascade,
  updated_at  timestamptz not null default now(),
  payload     jsonb       not null
);

-- Ingestion audit trail (also feeds the /api/status endpoint).
create table public.ingest_log (
  id          bigint generated always as identity primary key,
  world       text        not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text        not null default 'running' check (status in ('running', 'ok', 'unchanged', 'error')),
  message     text,
  snapshot_id bigint
);
create index ingest_log_world_started_idx on public.ingest_log (world, started_at desc);

-- Lock everything down: RLS on, no policies, no grants for public API roles.
alter table public.snapshots        enable row level security;
alter table public.tribe_stats      enable row level security;
alter table public.players          enable row level security;
alter table public.alliances        enable row level security;
alter table public.player_history   enable row level security;
alter table public.alliance_history enable row level security;
alter table public.map_cache        enable row level security;
alter table public.ingest_log       enable row level security;

revoke all on public.snapshots, public.tribe_stats, public.players, public.alliances,
              public.player_history, public.alliance_history, public.map_cache, public.ingest_log
  from anon, authenticated;

-- One-transaction ingest of an already-aggregated snapshot (see src/aggregate.js for the payload shape).
create or replace function public.ingest_snapshot(p jsonb)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_world   text   := p->>'world';
  v_id      bigint;
  v_new     integer := 0;
  v_gone    integer := 0;
  v_top_n   integer := coalesce((p->>'history_top_players')::integer, 500);
  t         jsonb  := p->'totals';
begin
  insert into snapshots (
    world, source_url, content_hash, etag, source_last_modified,
    tiles, players, alliances, villages, natar_villages, population,
    capitals, cities, harbors, players_in_alliance, meta
  ) values (
    v_world, p->>'source_url', p->>'content_hash', p->>'etag',
    nullif(p->>'source_last_modified', '')::timestamptz,
    coalesce((t->>'tiles')::int, 0), coalesce((t->>'players')::int, 0), coalesce((t->>'alliances')::int, 0),
    coalesce((t->>'villages')::int, 0), coalesce((t->>'natar_villages')::int, 0), coalesce((t->>'population')::bigint, 0),
    coalesce((t->>'capitals')::int, 0), coalesce((t->>'cities')::int, 0), coalesce((t->>'harbors')::int, 0),
    coalesce((t->>'players_in_alliance')::int, 0), coalesce(p->'meta', '{}'::jsonb)
  )
  on conflict (world, content_hash) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from snapshots where world = v_world and content_hash = p->>'content_hash';
    return v_id;  -- identical content already stored
  end if;

  insert into tribe_stats (snapshot_id, tribe, players, villages, population)
  select v_id, x.tribe, x.players, x.villages, x.population
  from jsonb_to_recordset(p->'tribes') as x(tribe smallint, players int, villages int, population bigint);

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

  -- A player is only "new" relative to an existing dataset; the very first snapshot has no baseline.
  if not exists (select 1 from snapshots where world = v_world and id <> v_id) then
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

  -- History is kept for the top-N players only, to stay inside small database plans.
  insert into player_history (snapshot_id, player_id, population, villages, alliance_id)
  select v_id, x.id, x.population, x.villages, x.alliance_id
  from jsonb_to_recordset(p->'players') as x(id bigint, population int, villages int, alliance_id bigint)
  order by x.population desc, x.id
  limit v_top_n;

  update snapshots set new_players = v_new, departed_players = v_gone where id = v_id;

  return v_id;
end;
$$;

revoke execute on function public.ingest_snapshot(jsonb) from public, anon, authenticated;
grant  execute on function public.ingest_snapshot(jsonb) to service_role;
