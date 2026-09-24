'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { createApp } = require('../src/server');
const { Ingestor } = require('../src/ingest');
const { MemoryStore } = require('../src/store/memory');
const { createWorld, advance, toMapSql, silent, testConfig, fakeFetcher } = require('../scripts/test-helpers');

async function boot(over = {}, { days = 3 } = {}) {
  const config = testConfig(over);
  const store = new MemoryStore();
  const state = { text: '' };
  const world = createWorld({ seed: 21, players: 200, alliances: 8, regions: true });
  const holder = {};
  const ingestor = new Ingestor({ store, config, logger: silent, fetcher: fakeFetcher(state), onIngested: () => holder.app && holder.app.cache.clear() });
  for (let d = 0; d <= days; d++) {
    if (d) advance(world);
    state.text = toMapSql(world);
    assert.equal((await ingestor.run()).status, 'ok');
  }
  const app = createApp({ config, store, ingestor, logger: silent });
  holder.app = app;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, world, state, config, ingestor, close: () => new Promise((r) => app.server.close(r)) };
}

const getJson = async (base, path, init) => {
  const res = await fetch(base + path, init);
  return { res, body: await res.json().catch(() => null) };
};

test('API endpoints return consistent data', async () => {
  const t = await boot();
  try {
    const { res, body: ov } = await getJson(t.base, '/api/overview');
    assert.equal(res.status, 200);
    assert.equal(ov.totals.players, t.world.players.filter((p) => p.leftDay === null).length);
    assert.equal(ov.top_players.length, 10);
    assert.ok(ov.distributions.pop_buckets.length > 5);
    assert.ok(ov.tribes.some((x) => x.tribe === 5));

    const players = (await getJson(t.base, '/api/players?limit=5&sort=population&dir=desc')).body;
    assert.equal(players.rows.length, 5);
    assert.ok(players.rows[0].population >= players.rows[1].population);
    assert.equal(players.total, ov.totals.players);

    const found = (await getJson(t.base, "/api/players?q=o'bri")).body;
    assert.equal(found.rows.length, 1);
    assert.equal(found.rows[0].name, "O'Brien");

    const byTribe = (await getJson(t.base, '/api/players?tribe=2&limit=100')).body;
    assert.ok(byTribe.rows.length > 0 && byTribe.rows.every((r) => r.tribe === 2));

    const one = (await getJson(t.base, `/api/players/${players.rows[0].id}`)).body;
    assert.equal(one.player.id, players.rows[0].id);
    assert.equal(one.history.length, 4);
    assert.equal((await getJson(t.base, '/api/players/99999999')).res.status, 404);

    const al = (await getJson(t.base, '/api/alliances?limit=3')).body;
    assert.equal(al.rows.length, 3);
    const a1 = (await getJson(t.base, `/api/alliances/${al.rows[0].id}`)).body;
    assert.equal(a1.history.length, 4);

    const hist = (await getJson(t.base, '/api/history')).body;
    assert.equal(hist.snapshots.length, 4);
    const map = (await getJson(t.base, '/api/map')).body;
    assert.equal(map.count, map.x.length);
    assert.ok(map.pn.length > 100);

    const mv = (await getJson(t.base, '/api/movers?limit=5')).body;
    assert.ok(mv.gainers.length > 0);
    const st = (await getJson(t.base, '/api/status')).body;
    assert.equal(st.store, 'memory');
    assert.equal(st.latest_snapshot.id, 4);
    assert.equal((await getJson(t.base, '/api/nope')).res.status, 404);
    assert.equal((await getJson(t.base, '/api/players', { method: 'DELETE' })).res.status, 405);
  } finally {
    await t.close();
  }
});

test('security headers, health check, gzip and ETag revalidation', async () => {
  const t = await boot();
  try {
    const health = await fetch(`${t.base}/healthz`);
    assert.equal(health.status, 200);
    assert.match(health.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');

    const raw = await new Promise((resolve, reject) => {
      http.get(`${t.base}/api/map`, { headers: { 'accept-encoding': 'gzip' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    assert.equal(raw.res.headers['content-encoding'], 'gzip');
    assert.ok(JSON.parse(zlib.gunzipSync(raw.body).toString()).count > 100);

    const etag = raw.res.headers.etag;
    const again = await fetch(`${t.base}/api/map`, { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
  } finally {
    await t.close();
  }
});

test('static frontend is served and path traversal is refused', async () => {
  const t = await boot({}, { days: 0 });
  try {
    const index = await fetch(`${t.base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Tra5x/);
    for (const p of ['/js/app.js', '/js/charts.js', '/js/map.js', '/css/styles.css', '/favicon.svg']) {
      assert.equal((await fetch(t.base + p)).status, 200, p);
    }
    assert.equal((await fetch(`${t.base}/..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${t.base}/%2e%2e/src/config.js`)).status, 404);
    assert.equal((await fetch(`${t.base}/missing.txt`)).status, 404);
  } finally {
    await t.close();
  }
});

test('admin refresh needs the bearer token and can be disabled', async () => {
  const off = await boot({ adminToken: '' }, { days: 0 });
  try {
    assert.equal((await getJson(off.base, '/api/admin/refresh', { method: 'POST' })).res.status, 404);
  } finally {
    await off.close();
  }
  const t = await boot({ adminToken: 's3cret' }, { days: 0 });
  try {
    assert.equal((await getJson(t.base, '/api/admin/refresh', { method: 'POST' })).res.status, 401);
    assert.equal((await getJson(t.base, '/api/admin/refresh', { method: 'POST', headers: { authorization: 'Bearer nope' } })).res.status, 401);
    const ok = await getJson(t.base, '/api/admin/refresh?wait=1', { method: 'POST', headers: { authorization: 'Bearer s3cret' } });
    assert.equal(ok.res.status, 200);
    assert.equal(ok.body.status, 'unchanged');
  } finally {
    await t.close();
  }
});

test('per-IP rate limit answers 429', async () => {
  const t = await boot({ rateLimitPerMin: 5 }, { days: 0 });
  try {
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await fetch(`${t.base}/api/status`)).status);
    assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.ok(codes.slice(5).every((c) => c === 429));
    assert.equal((await fetch(`${t.base}/healthz`)).status, 200); // health checks are not limited
  } finally {
    await t.close();
  }
});

test('empty database: overview says so instead of failing', async () => {
  const config = testConfig();
  const store = new MemoryStore();
  const app = createApp({ config, store, logger: silent });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const ov = (await getJson(base, '/api/overview')).body;
    assert.equal(ov.empty, true);
    assert.equal((await getJson(base, '/api/map')).body.empty, true);
    assert.equal((await getJson(base, '/api/history')).body.snapshots.length, 0);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});
