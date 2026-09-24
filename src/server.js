'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');

const defaultConfig = require('./config');
const { createStore } = require('./store');
const { Ingestor } = require('./ingest');
const { buildOverview, buildHistory, tribeName } = require('./views');
const { applySecurityHeaders, sendEntry, sendJson, ResponseCache, RateLimiter, createStaticServer } = require('./http-utils');

const TTL = 60 * 1000; // API responses change at most once a day; 60 s keeps the database quiet

const clampInt = (v, min, max, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const optInt = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function createApp({ config = defaultConfig, store, ingestor, logger = console } = {}) {
  store = store || createStore(config, logger);
  const cache = new ResponseCache();
  ingestor = ingestor || new Ingestor({ store, config, logger, onIngested: () => cache.clear() });
  const limiter = new RateLimiter(config.rateLimitPerMin);
  const serveStatic = createStaticServer(path.join(__dirname, '..', 'public'));
  const world = config.world;

  /** cached JSON GET */
  const cached = (req, res, url, ttl, produce, opts) =>
    cache.get(req.url, ttl, produce).then((entry) => sendEntry(req, res, entry, { cacheControl: `public, max-age=${Math.floor((opts?.maxAge ?? ttl) / 1000)}` }));

  async function api(req, res, url) {
    const p = url.pathname;
    const q = url.searchParams;

    if (req.method === 'POST' && p === '/api/admin/refresh') {
      if (!config.adminToken) return sendJson(req, res, 404, { error: 'Not found' });
      const auth = String(req.headers.authorization || '');
      if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), config.adminToken)) return sendJson(req, res, 401, { error: 'Unauthorized' });
      const force = q.get('force') === '1';
      if (q.get('wait') === '1') return sendJson(req, res, 200, await ingestor.run({ force, reason: 'admin' }));
      if (ingestor.running) return sendJson(req, res, 409, { status: 'busy' });
      ingestor.run({ force, reason: 'admin' });
      return sendJson(req, res, 202, { status: 'started', hint: 'Poll GET /api/status for the result' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(req, res, 405, { error: 'Method not allowed' });

    // Any API traffic gives the scheduler a chance to notice a due refresh (matters on sleeping free-tier hosts).
    ingestor.maybeRefresh().catch(() => {});

    switch (p) {
      case '/api/status':
        return sendJson(req, res, 200, await status());

      case '/api/overview':
        return cached(req, res, url, TTL, async () => (await buildOverview(store, world)) || { world, empty: true });

      case '/api/history': {
        const days = clampInt(q.get('days'), 0, 3650, 0);
        return cached(req, res, url, TTL, () => buildHistory(store, world, { days }));
      }

      case '/api/players':
        return cached(req, res, url, TTL, async () => {
          const limit = clampInt(q.get('limit'), 1, 100, 50);
          const offset = clampInt(q.get('offset'), 0, 1e6, 0);
          const { rows, total } = await store.listPlayers(world, {
            q: (q.get('q') || '').slice(0, 40),
            tribe: optInt(q.get('tribe')),
            alliance: optInt(q.get('alliance')),
            tag: (q.get('tag') || '').slice(0, 20),
            sort: q.get('sort') || 'rank',
            dir: q.get('dir') || 'asc',
            limit,
            offset,
          });
          return { total, limit, offset, rows: rows.map((r) => ({ ...r, tribe_name: tribeName(r.tribe) })) };
        });

      case '/api/alliances':
        return cached(req, res, url, TTL, async () => {
          const limit = clampInt(q.get('limit'), 1, 100, 50);
          const offset = clampInt(q.get('offset'), 0, 1e6, 0);
          const { rows, total } = await store.listAlliances(world, {
            q: (q.get('q') || '').slice(0, 20),
            sort: q.get('sort') || 'rank',
            dir: q.get('dir') || 'asc',
            limit,
            offset,
          });
          return { total, limit, offset, rows };
        });

      case '/api/movers':
        return cached(req, res, url, TTL, async () => {
          const limit = clampInt(q.get('limit'), 1, 50, 15);
          const [gainers, losers] = await Promise.all([store.getMovers(world, 'gain', limit), store.getMovers(world, 'loss', limit)]);
          return { gainers, losers };
        });

      case '/api/map': {
        // The map payload only changes when a new snapshot arrives; let browsers keep it for 10 minutes.
        return cached(
          req,
          res,
          url,
          10 * 60 * 1000,
          async () => {
            const row = await store.getMap(world);
            return row ? { snapshot_id: row.snapshot_id, updated_at: row.updated_at, ...row.payload } : { empty: true };
          },
          { maxAge: 10 * 60 * 1000 },
        );
      }
      default:
    }

    const m = /^\/api\/players\/(\d+)$/.exec(p);
    if (m) {
      const id = Number(m[1]);
      const player = await store.getPlayer(world, id);
      if (!player) return sendJson(req, res, 404, { error: 'Player not found' });
      const history = await store.getPlayerHistory(id, 400);
      return sendJson(req, res, 200, { player: { ...player, tribe_name: tribeName(player.tribe) }, history });
    }

    const a = /^\/api\/alliances\/(\d+)$/.exec(p);
    if (a) {
      const id = Number(a[1]);
      const alliance = await store.getAlliance(world, id);
      if (!alliance) return sendJson(req, res, 404, { error: 'Alliance not found' });
      const series = await store.getSnapshotSeries(world, 400);
      const history = await store.getAllianceHistory([id], series.map((s) => s.id));
      return sendJson(req, res, 200, { alliance, history });
    }

    return sendJson(req, res, 404, { error: 'Not found' });
  }

  async function status() {
    const [latest, log] = await Promise.all([store.getRecentSnapshots(world, 1), store.getIngestLog(world, 5)]);
    const s = latest[0] || null;
    return {
      world,
      store: store.kind,
      warning: store.kind === 'memory' ? 'In-memory store: history is lost when the server restarts.' : null,
      server_time: new Date().toISOString(),
      latest_snapshot: s && { id: s.id, taken_at: s.taken_at, source_last_modified: s.source_last_modified, players: s.players, villages: s.villages, alliances: s.alliances },
      ingest: ingestor.state(),
      recent_ingests: log,
      refresh: { auto: config.autoRefresh, after_hours: config.refreshAfterHours, poll_minutes: config.pollMinutes },
      source: config.mapFile ? 'local file' : config.mapUrl,
    };
  }

  const handler = async (req, res) => {
    try {
      applySecurityHeaders(req, res);
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/healthz') {
        res.setHeader('cache-control', 'no-store');
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        return res.end('ok');
      }

      if (url.pathname.startsWith('/api/')) {
        const rl = limiter.check(req);
        if (!rl.ok) {
          res.setHeader('retry-after', String(rl.retryAfter));
          return sendJson(req, res, 429, { error: 'Too many requests' });
        }
        return await api(req, res, url);
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        return res.end('Method not allowed');
      }
      if (await serveStatic(req, res, url.pathname)) return undefined;
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.end('Not found');
    } catch (err) {
      logger.error(`[tra5x] ${req.method} ${req.url} -> ${err.stack || err.message}`);
      if (!res.headersSent) return sendJson(req, res, 500, { error: 'Internal server error' });
      res.end();
      return undefined;
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res);
  });
  server.keepAliveTimeout = 65000; // above Render's proxy idle timeout
  return { server, store, ingestor, cache };
}

function start() {
  const config = defaultConfig;
  const app = createApp({ config });
  app.server.listen(config.port, '0.0.0.0', () => {
    console.log(`[tra5x] listening on :${config.port} - world ${config.world} - store ${app.store.kind}`);
  });

  if (config.autoRefresh) {
    setTimeout(() => app.ingestor.maybeRefresh().catch(() => {}), 3000).unref();
    setInterval(() => app.ingestor.maybeRefresh().catch(() => {}), 15 * 60 * 1000).unref();
  }

  const shutdown = () => {
    console.log('[tra5x] shutting down');
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return app;
}

if (require.main === module) start();

module.exports = { createApp, start };
