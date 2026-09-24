# Tra5x

Macro statistics dashboard for the Travian world **rog.x5.international.travian.com**, built on the game's public
`map.sql` export. Node.js (no npm dependencies) + Supabase (Postgres) + a static dashboard, ready for Render.

## What you get

| Tab | Content |
| --- | --- |
| Overview | Players, alliances, villages, population with change since the previous snapshot; tribe split (players / villages / population); player-size and villages-per-player distributions; quadrants and distance rings; top 10 players and alliances; biggest gainers and losers. |
| Players | Searchable, sortable, filterable table (tribe, alliance tag); detail dialog with population history and a link to the map. |
| Alliances | Sortable table; detail dialog with member list and population history. |
| Trends | Population, villages, players, alliances over time; player churn; population by tribe; top-5 alliances. Ranges 7 / 30 / 90 days / all. |
| Map | Canvas map with density heat-map, tribe view, alliance highlight, player search, pan / zoom, hover details. |

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
 '- public/            vanilla JS dashboard, hand-drawn SVG charts, canvas map
Supabase project "Tra5x" (Paris, eu-west-3, ref fqvdwbrnfbmtvdghkvzr)
 '- tables: snapshots, tribe_stats, players, alliances, player_history, alliance_history, map_cache, ingest_log
    function: ingest_snapshot(jsonb)  (one transaction per daily snapshot)
```

The database schema is in `supabase/migrations/` and is **already applied** to the Tra5x project. All tables have row level
security enabled with no policies and no grants for `anon`/`authenticated`: only the server, using the service-role key,
can read or write. The browser never talks to Supabase directly.

Storage stays small: per day it keeps one `snapshots` row, a few `tribe_stats` rows, one `alliance_history` row per
alliance and `player_history` rows for the top `HISTORY_TOP_PLAYERS` (default 500) players. The current state of every
player and alliance is kept in `players` / `alliances`, with the previous population for the 24 h deltas.

## Refresh schedule

The service checks whether a download is due on boot, every 15 minutes, and whenever the API gets traffic:

1. After a new snapshot is stored it stays quiet for `REFRESH_AFTER_HOURS` (20).
2. Then it polls every `REFRESH_POLL_MINUTES` (60) with `If-None-Match` / `If-Modified-Since` and a SHA-256 check,
   so unchanged files are never re-processed.
3. A failed attempt is retried after `REFRESH_RETRY_MINUTES` (15). Truncated or HTML responses are rejected
   ("refusing to ingest") and reported in `/api/status` and in a banner on the dashboard.

On a free Render instance the service sleeps when idle and refreshes when it wakes. For an always-on service choose the
Starter plan, or ping `/api/status` every 5-10 minutes from a free uptime monitor.

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
npm test                 # 26 tests: parser, aggregation, ingestion rules, API, security, rate limit, Supabase client
npm run demo             # dashboard on http://127.0.0.1:3000 with SYNTHETIC data (21 fake days), in-memory store
node --env-file=.env src/server.js   # real run: needs SUPABASE_SERVICE_ROLE_KEY in .env
npm run ingest           # one-shot download + store (cron / GitHub Actions friendly), add -- --force to override checks
```

Without Supabase credentials the server uses the in-memory store and says so in a banner.

## API (all JSON, GET unless noted)

`/healthz` (plain text) - `/api/status` - `/api/overview` - `/api/history?days=30` - `/api/players?q=&tribe=&tag=&alliance=&sort=&dir=&limit=&offset=` -
`/api/players/:id` - `/api/alliances?q=&sort=&dir=&limit=&offset=` - `/api/alliances/:id` - `/api/movers` - `/api/map` -
`POST /api/admin/refresh` (bearer token).

## Troubleshooting

- **"The server returned HTML instead of map.sql"**: the game server blocked or throttled the request. Set `USER_AGENT`
  to something that identifies you, or try again later; do not poll faster than the defaults.
- **"No x_world rows could be parsed"**: the file format changed. The message shows the first characters of the file;
  the parser is in `src/parser.js` and the column order in its header comment.
- **Empty dashboard after deploy**: check `/api/status` and the Render logs (`[tra5x] ingest ...` lines).

Not affiliated with Travian Games. Please respect the game's terms of use and keep the polling defaults.
