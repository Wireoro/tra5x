# Tra5x

Macro statistics dashboard for the Travian world **rog.x5.international.travian.com**, built on the game's public
`map.sql` export. Node.js (no npm dependencies) + Supabase (Postgres) + a static dashboard, ready for Render.

## What you get

| Tab | Content |
| --- | --- |
| Overview | Players, alliances, villages, population with change since the previous snapshot; tribe split (players / villages / population); player-size and villages-per-player distributions; quadrants and distance rings; top 10 players and alliances; biggest gainers and losers. |
| Players | Searchable, sortable, filterable table (tribe, alliance tag); detail dialog with population history and recent activity. |
| Alliances | Sortable table; detail dialog with member list and population history. |
| Trends | Population, villages, players, alliances over time; player churn; population by tribe; top-5 alliances; population concentration (top 10 / top 100 share). Ranges 7 / 30 / 90 days / all. |
| Activity | Change log between daily snapshots: villages founded / conquered / lost, new and departed players, alliance joins, leaves and switches, alliances founded and dissolved. Player and alliance dialogs show their own recent activity. |
| Compare | Type a player name: the players ranked just above and below (5 to 25 each way) with population, villages and rank, and how much each grew over 1 day, 7 days, 30 days or since the first snapshot. Every row shows the difference in growth against that player ("vs you": ▲ grew faster, ▼ slower), the village and rank change, and **how far away the player is** (see "How distances are measured"), plus a chart of that player against the nearest ranks and a summary (median growth around you, your growth rank, your centre, your nearest neighbour). Links like `#/compare?player=Name&days=7` can be shared; a mistyped name shows "did you mean" suggestions. |

Every chart has a "Table view" with the same numbers, and there is a light and a dark theme.

## Data source and limits

Travian publishes `https://<server>/map.sql` (table `x_world`, 16 columns: tile id, x, y, tribe, village id, village name,
player id, player name, alliance id, alliance tag, population, region, capital, city, harbour, victory points).
The file is regenerated **once a day at server midnight**, so history is one point per day. It contains no troops, resources
or buildings, so Tra5x is a macro tool: who exists, where, how big, and how fast they grow.

Natars (tribe 5) are counted separately and excluded from player and alliance rankings. Victory points are parsed but
not shown, because their per-village semantics are not documented.

## Architecture

```
Render web service (Node 22, zero dependencies)
 |- src/ingest.js      download map.sql (conditional GET + content hash) -> parse -> aggregate
 |- src/store/         Supabase REST (PostgREST over fetch) | in-memory store for demos/tests
 |- src/server.js      JSON API + static dashboard, gzip, ETag, CSP, per-IP rate limit
 '- public/            vanilla JS dashboard, hand-drawn SVG charts
Supabase project "Tra5x" (Paris, eu-west-3, ref fqvdwbrnfbmtvdghkvzr)
 '- tables: snapshots, tribe_stats, snapshot_breakdowns, players, alliances, player_history, alliance_history,
    |         events, map_cache, ingest_log
    '- functions: ingest_snapshot(jsonb) (one transaction per daily snapshot), prune_history(), storage_stats()
```

The database schema is in `supabase/migrations/` and is **already applied** to the Tra5x project. All tables have row level
security enabled with no policies and no grants for `anon`/`authenticated`: only the server, using the service-role key,
can read or write. The browser never talks to Supabase directly.

### What is recorded every day

Each new `map.sql` becomes one **snapshot**, and everything below is stored against it, so any statistic can be charted
over time:

| Table | One row per day for... |
| --- | --- |
| `snapshots` | the world: players, alliances, villages, Natar villages, population, capitals, cities, harbours, players in alliances, new / departed players, top-10 and top-100 population share, plus the raw distributions as JSON |
| `tribe_stats` | every tribe: players, villages, population |
| `alliance_history` | **every alliance**: members, villages, population |
| `player_history` | **every player**: population, villages, alliance, tribe, rank |
| `snapshot_breakdowns` | every bucket of the player-size and villages-per-player distributions, every quadrant, distance ring and region |
| `events` | every change since the previous day (see below) |

`events` kinds: `village_founded`, `village_conquered` (new owner and previous owner), `village_abandoned`, `player_new`,
`player_departed`, `alliance_joined`, `alliance_left`, `alliance_switched`, `alliance_created`, `alliance_disbanded`.
Village events come from comparing today's map with yesterday's tile by tile; the first snapshot has no baseline, so it
produces none. If a single day would create more than `MAX_VILLAGE_EVENTS` (30 000) village changes, for example after a
world reset, village events are skipped for that day and a warning is logged.

`players` and `alliances` hold the current state, with the previous population for the 24 h deltas. `map_cache` holds the
latest compact village list, used to detect village changes and to measure distances between players.

### How distances are measured (Compare tab)

Distance is the straight line between two villages, in fields: the square root of (x difference² + y difference²), as in
the game. The map wraps around like a globe (Travian support: "Guide: The Map"), so the shorter way round is used on each
axis; on a 401 x 401 map a village at x = 200 is one field from one at x = -200. The map size is read from the extent of the
tiles in `map.sql` (it lists every tile, empty ones included).

A player owns scattered villages, so two numbers are given, each exactly defined:

- **Distance = closest approach**: the shortest distance between any village of yours and any village of theirs (the two
  villages are shown). This is the distance at which two players can actually reach each other, and is the headline number.
- **Centre**: the distance between the two players' centres of gravity, i.e. village coordinates averaged with the village
  population as weight (computed as a circular mean so that villages on both sides of the map edge do not average out to the
  middle of the map). Each player also gets a **spread**, the average distance of their villages from their own centre. When
  the spread is large compared with the centre distance the centre falls between clusters; trust the closest approach then. If
  a player's villages are spread evenly around the entire world no centre is reported.

Travel time is deliberately not shown: it depends on unit speed, server speed and the tournament square, all of which
start from the distance in fields.

### Database size (read this before going live)

Measured on the real schema with a 30 000-player world: about **4 MB per day**, almost all of it `player_history`
(one row per player per day, roughly 130 bytes including indexes). That is about 1.4 GB a year. The Supabase free plan
includes 500 MB, which is enough for roughly **3-4 months** at that world size; smaller worlds last proportionally longer.

The footer of the dashboard and `/api/status` show the database size, how much of `DB_SIZE_LIMIT_MB` is used and an
estimate of the days left, and a banner appears at 80 %. Options when it gets close:

- `HISTORY_RETENTION_DAYS=180` deletes snapshots (with all their history rows and events) older than that after each
  ingestion. The newest snapshot is never deleted.
- `HISTORY_TOP_PLAYERS=2000` keeps the per-day history for the top N players only (0 = every player).
- Upgrade the Supabase plan.

## Refresh schedule

The service checks whether a download is due on boot, every 15 minutes, and whenever the API gets traffic:

1. After a new snapshot is stored it stays quiet for `REFRESH_AFTER_HOURS` (20).
2. Then it polls every `REFRESH_POLL_MINUTES` (60) with `If-None-Match` / `If-Modified-Since` and a SHA-256 check,
   so unchanged files are never re-processed.
3. A failed attempt is retried after `REFRESH_RETRY_MINUTES` (15). Truncated or HTML responses are rejected
   ("refusing to ingest") and reported in `/api/status` and in a banner on the dashboard.

On a free Render instance the service sleeps when idle and only refreshes while awake. Travian publishes just today's
file, so **a day the service was asleep at midnight is a gap in the history that cannot be filled afterwards**. Avoid gaps
by choosing the Starter plan, or by pinging `/healthz` every 10 minutes from a free uptime monitor (one always-on free
service fits within Render's 750 free hours a month). As a second safety net, a scheduler such as cron-job.org can call
`POST /api/admin/refresh` with the bearer token shortly after server midnight.

## Deploy on Render

1. Push this folder to a GitHub repository.
2. Render dashboard > New > Blueprint > pick the repo (it reads `render.yaml`).
3. When asked, set `SUPABASE_SERVICE_ROLE_KEY`: Supabase dashboard > Project Settings > API Keys > `service_role`
   (or a `sb_secret_...` key). Treat it like a password; it must only live in Render's environment settings.
4. After the first deploy, open `https://<your-service>.onrender.com/api/status`. `latest_snapshot` should fill in within a
   minute. If `ingest.lastResult.status` is `error`, its message says why (blocked request, HTML page, format change...).
5. Optional: `POST /api/admin/refresh?wait=1&force=1` with `Authorization: Bearer <ADMIN_TOKEN>` forces a download.

## Run locally

```bash
npm test                 # 51 tests: parser, aggregation, ingestion rules, change log, compare + distances, API, security, rate limit, Supabase client
npm run demo             # dashboard on http://127.0.0.1:3000 with SYNTHETIC data (21 fake days), in-memory store
node --env-file=.env src/server.js   # real run: needs SUPABASE_SERVICE_ROLE_KEY in .env
npm run ingest           # one-shot download + store (cron / GitHub Actions friendly), add -- --force to override checks
```

Without Supabase credentials the server uses the in-memory store and says so in a banner.

## API (all JSON, GET unless noted)

`/healthz` (plain text) - `/api/status` - `/api/overview` - `/api/history?days=30` - `/api/players?q=&tribe=&tag=&alliance=&sort=&dir=&limit=&offset=` -
`/api/players/:id` (with history and recent events) - `/api/alliances?q=&sort=&dir=&limit=&offset=` - `/api/alliances/:id` -
`/api/events?kind=village|alliance|player|<kind,...>&player=&alliance=&snapshot=&limit=&offset=` -
`/api/breakdowns?kind=region|ring|quadrant|pop_bucket|village_bucket&days=` -
`/api/compare?player=<name or id>&above=10&below=10&days=7` (days=0: since the first snapshot; rows carry `distance`, `centre_distance`, `spread`) - `/api/movers` -
`POST /api/admin/refresh` (bearer token).

## Troubleshooting

- **"The server returned HTML instead of map.sql"**: the game server blocked or throttled the request. Set `USER_AGENT`
  to something that identifies you, or try again later; do not poll faster than the defaults.
- **"No x_world rows could be parsed"**: the file format changed. The message shows the first characters of the file;
  the parser is in `src/parser.js` and the column order in its header comment.
- **Empty dashboard after deploy**: check `/api/status` and the Render logs (`[tra5x] ingest ...` lines).

Not affiliated with Travian Games. Please respect the game's terms of use and keep the polling defaults.
