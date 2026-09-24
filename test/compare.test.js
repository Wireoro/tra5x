'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Ingestor } = require('../src/ingest');
const { MemoryStore } = require('../src/store/memory');
const { SupabaseStore } = require('../src/store/supabase');
const { buildCompare, CompareError, pickReference } = require('../src/compare');
const { createApp } = require('../src/server');
const { createWorld, advance, toMapSql, silent, testConfig, fakeFetcher } = require('../scripts/test-helpers');

const DAY = 86400000;

/** Ingests `days + 1` daily snapshots and spaces their timestamps exactly one day apart (oldest first). */
async function ingestDays(days, over = {}) {
  const config = testConfig(over);
  const store = new MemoryStore();
  const state = { text: '' };
  const world = createWorld({ seed: 44, players: 120, alliances: 6 });
  const ingestor = new Ingestor({ store, config, logger: silent, fetcher: fakeFetcher(state) });
  for (let d = 0; d <= days; d++) {
    if (d) advance(world);
    state.text = toMapSql(world);
    assert.equal((await ingestor.run()).status, 'ok');
  }
  const base = Date.now() - days * DAY;
  store.snapshots.forEach((s, i) => {
    s.taken_at = new Date(base + i * DAY).toISOString();
  });
  return { config, store, world };
}

test('pickReference chooses the stored snapshot closest to the requested age', () => {
  const t = (h) => new Date(Date.UTC(2026, 8, 1) + h * 3600 * 1000).toISOString();
  // uneven ingest times: 0 h, 23 h, 49 h, 71 h, 96 h
  const series = [0, 23, 49, 71, 96].map((h, i) => ({ id: i + 1, taken_at: t(h) }));
  assert.equal(pickReference(series, 1).id, 4); // 25 h before the latest is closer to the 71 h snapshot than to 49 h
  assert.equal(pickReference(series, 2).id, 3); // target 48 h before 96 h = 48 h -> the 49 h snapshot
  assert.equal(pickReference(series, 30).id, 1); // longer than the history: the oldest one
  assert.equal(pickReference(series, 0).id, 1); // 0 = since the first snapshot
  assert.equal(pickReference([series[0]], 7), null); // a single snapshot has no past
});

test('buildCompare returns the ranks around a player with growth measured against the player', async () => {
  const { store, config } = await ingestDays(5);
  const all = (await store.listPlayers(config.world, { sort: 'rank', limit: 500 })).rows;
  const me = all[60]; // somewhere in the middle
  const r = await buildCompare(store, config.world, { name: me.name.toUpperCase(), above: 3, below: 4, days: 3 });

  assert.equal(r.me.id, me.id);
  assert.equal(r.rows.length, 3 + 1 + 4);
  assert.equal(r.above, 3);
  assert.equal(r.below, 4);
  assert.deepEqual(r.rows.map((x) => x.rank), all.slice(57, 65).map((x) => x.rank));
  assert.equal(r.rows.filter((x) => x.is_me).length, 1);
  assert.equal(r.period.actual_days, 3);
  assert.equal(r.period.truncated, false);

  const snaps = await store.getRecentSnapshots(config.world, 10);
  const byTime = [...snaps].sort((a, b) => Date.parse(a.taken_at) - Date.parse(b.taken_at));
  const refSnap = byTime[byTime.length - 1 - 3];
  for (const row of r.rows) {
    const then = store.playerHistory.find((h) => h.snapshot_id === refSnap.id && h.player_id === row.id);
    if (!then) {
      assert.equal(row.gain, null);
      continue;
    }
    assert.equal(row.population_then, then.population);
    assert.equal(row.gain, row.population - then.population);
    assert.equal(row.village_gain, row.villages - then.villages);
    assert.equal(row.rank_change, then.rank - row.rank);
    assert.ok(Math.abs(row.gain_pct - row.gain / then.population) < 1e-12);
    if (!row.is_me && r.me.gain != null) {
      assert.equal(row.vs_me_pop, row.gain - r.me.gain);
      assert.ok(Math.abs(row.vs_me_pct - (row.gain_pct - r.me.gain_pct)) < 1e-12);
    }
  }
  assert.equal(r.me.vs_me_pct, null);

  // summary agrees with the rows
  const others = r.rows.filter((x) => !x.is_me && x.gain_pct != null);
  assert.equal(r.summary.compared, others.length);
  assert.equal(r.summary.faster + r.summary.slower + r.summary.same, others.length);
  assert.equal(r.summary.faster, others.filter((x) => x.gain_pct > r.me.gain_pct).length);
  assert.equal(r.summary.my_growth_position, 1 + r.summary.faster);
  assert.ok(r.summary.median_gain_pct != null);

  // chart series: the player first, then the nearest ranks, one aligned point per snapshot since the reference day
  assert.equal(r.series.times.length, 4);
  assert.equal(r.series.players[0].id, me.id);
  assert.equal(r.series.players[0].is_me, true);
  assert.ok(r.series.players.length <= 7);
  for (const p of r.series.players) assert.equal(p.points.length, r.series.times.length);
  assert.equal(r.series.players[0].points.at(-1), me.population);
});

test('the reference day follows the requested period and reports truncated history', async () => {
  const { store, config } = await ingestDays(4);
  const someone = (await store.listPlayers(config.world, { sort: 'rank', limit: 1, offset: 10 })).rows[0];
  const day1 = await buildCompare(store, config.world, { name: someone.name, days: 1 });
  assert.equal(day1.period.actual_days, 1);
  const all = await buildCompare(store, config.world, { name: someone.name, days: 0 });
  assert.equal(all.period.actual_days, 4);
  assert.equal(all.period.requested_days, null);
  assert.equal(all.series.times.length, 5);
  const long = await buildCompare(store, config.world, { name: someone.name, days: 30 });
  assert.equal(long.period.actual_days, 4);
  assert.equal(long.period.truncated, true);
});

test('near the top of the ranking there are fewer players above', async () => {
  const { store, config } = await ingestDays(2);
  const first = (await store.listPlayers(config.world, { sort: 'rank', limit: 1 })).rows[0];
  const r = await buildCompare(store, config.world, { name: first.name, above: 10, below: 2, days: 1 });
  assert.equal(r.above, 0);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].is_me, true);
});

test('with a single snapshot the ranking is shown and growth is empty', async () => {
  const { store, config } = await ingestDays(0);
  const p = (await store.listPlayers(config.world, { sort: 'rank', limit: 1, offset: 5 })).rows[0];
  const r = await buildCompare(store, config.world, { name: p.name, days: 7 });
  assert.equal(r.period, null);
  assert.equal(r.snapshots_stored, 1);
  assert.ok(r.rows.length > 1);
  assert.ok(r.rows.every((x) => x.gain === null && x.gain_pct === null && x.rank_change === null));
  assert.equal(r.summary.my_growth_position, null);
  assert.equal(r.series.times.length, 1);
});

test('unknown names get suggestions; ids and case-insensitive names resolve', async () => {
  const { store, config } = await ingestDays(2);
  const p = (await store.listPlayers(config.world, { sort: 'rank', limit: 1, offset: 20 })).rows[0];

  const byId = await buildCompare(store, config.world, { name: String(p.id), days: 1 });
  assert.equal(byId.me.id, p.id);
  const byName = await buildCompare(store, config.world, { name: `  ${p.name.toLowerCase()} `, days: 1 });
  assert.equal(byName.me.id, p.id);

  const partial = p.name.slice(1, 4);
  await assert.rejects(buildCompare(store, config.world, { name: partial, days: 1 }), (e) => {
    assert.ok(e instanceof CompareError);
    assert.equal(e.status, 404);
    assert.ok(e.extra.suggestions.length > 0);
    assert.ok(e.extra.suggestions.some((s) => s.id === p.id));
    return true;
  });
  await assert.rejects(buildCompare(store, config.world, { name: 'zzzz-nobody', days: 1 }), (e) => e.status === 404 && e.extra.suggestions.length === 0);
});

test('GET /api/compare validates input and returns the comparison', async () => {
  const { store, config } = await ingestDays(3);
  const app = createApp({ config, store, logger: silent });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };
  try {
    const p = (await store.listPlayers(config.world, { sort: 'rank', limit: 1, offset: 30 })).rows[0];
    assert.equal((await get('/api/compare')).status, 400);
    assert.equal((await get('/api/compare?player=%20%20')).status, 400);

    const ok = await get(`/api/compare?player=${encodeURIComponent(p.name)}&above=2&below=2&days=1`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.me.id, p.id);
    assert.equal(ok.body.rows.length, 5);
    assert.equal(ok.body.period.actual_days, 1);

    // out-of-range sizes are clamped, not rejected
    const big = await get(`/api/compare?player=${encodeURIComponent(p.name)}&above=999&below=-4&days=abc`);
    assert.equal(big.status, 200);
    assert.equal(big.body.rows.length, Math.min(25, p.rank - 1) + 1); // 25 above (clamped), none below
    assert.equal(big.body.period.requested_days, 7);

    const missing = await get('/api/compare?player=nobody-here');
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /No player named/);
    assert.deepEqual(missing.body.suggestions, []);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

// ---------------------------------------------------------------- Supabase wiring
test('SupabaseStore: exact-name lookup escapes LIKE characters; history readers use the right filters', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
    res.writeHead(200, { 'content-type': 'application/json', 'content-range': '0-0/0' });
    res.end('[]');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const store = new SupabaseStore({ url: `http://127.0.0.1:${server.address().port}`, key: 'k' });

    await store.listPlayers('w', { exactName: 'Big_Bob*,(x)%', limit: 5 });
    assert.equal(seen.at(-1).params.name, 'ilike.Big\\_Bob   x  '.trimEnd());
    assert.equal(seen.at(-1).params.world, 'eq.w');

    await store.getPlayersAtSnapshot(12, [5, 6, 7]);
    assert.equal(seen.at(-1).path, '/rest/v1/player_history');
    assert.equal(seen.at(-1).params.snapshot_id, 'eq.12');
    assert.equal(seen.at(-1).params.player_id, 'in.(5,6,7)');
    assert.match(seen.at(-1).params.select, /rank/);

    await store.getPlayersHistory([5, 6], 9);
    assert.equal(seen.at(-1).params.snapshot_id, 'gte.9');
    assert.equal(seen.at(-1).params.player_id, 'in.(5,6)');
    assert.equal(seen.at(-1).params.order, 'snapshot_id.asc,player_id.asc');

    const before = seen.length;
    assert.deepEqual(await store.getPlayersAtSnapshot(1, []), []);
    assert.deepEqual(await store.getPlayersHistory([], 1), []);
    assert.equal(seen.length, before); // no request for an empty id list
  } finally {
    await new Promise((r) => server.close(r));
  }
});
