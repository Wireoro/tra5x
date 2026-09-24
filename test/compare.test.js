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
  const world = createWorld({ seed: 44, radius: 50, players: 150, alliances: 6 });
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

const geo = require('../src/geo');
const mapOf = (store, config) => async () => (await store.getMap(config.world)).payload;

/** Brute force from the synthetic world itself: active players with a village within `radius` fields of any of `me`'s. */
function expectedNearby(world, me, radius, g) {
  const out = new Map();
  for (const p of world.players) {
    if (p.leftDay !== null || p.id === me.id || !p.villages.length) continue;
    let best = Infinity;
    for (const a of me.villages) for (const b of p.villages) best = Math.min(best, geo.distance(g, a.x, a.y, b.x, b.y));
    if (best <= radius) out.set(p.id, best);
  }
  return out;
}

test('buildCompare lists exactly the players within the radius, ranked among themselves, with growth measured against the player', async () => {
  const { store, config, world } = await ingestDays(5);
  const getMap = mapOf(store, config);
  const g = geo.worldGeometry((await getMap()).bounds);
  const me = world.players.filter((p) => p.leftDay === null).sort((a, b) => b.villages.length - a.villages.length)[2]; // scattered enough to have neighbours
  const radius = 25;
  const want = expectedNearby(world, me, radius, g);
  assert.ok(want.size >= 5, `test world should give ${me.name} some neighbours (got ${want.size})`);

  const r = await buildCompare(store, config.world, { name: me.name.toUpperCase(), radius, origin: 'all', days: 3, getMap });
  assert.equal(r.me.id, me.id);
  assert.equal(r.radius, radius);
  assert.deepEqual(r.rows.map((x) => x.id).sort((a, b) => a - b), [me.id, ...want.keys()].sort((a, b) => a - b)); // nobody missing, nobody extra (no Natars)
  assert.deepEqual(r.nearby, { total: want.size, shown: want.size, truncated: false });
  for (const row of r.rows.filter((x) => !x.is_me)) {
    assert.ok(row.distance <= radius, `${row.name} is ${row.distance} away`);
    assert.equal(row.distance, geo.round1(want.get(row.id)));
    assert.ok(row.villages_in_range >= 1 && row.villages_in_range <= row.villages);
  }
  assert.equal(r.period.actual_days, 3);
  assert.equal(r.period.truncated, false);

  // rank = place among the listed players by population (1 = most), not the world rank
  assert.deepEqual(r.rows.map((x) => x.rank).sort((a, b) => a - b), r.rows.map((_, i) => i + 1));
  const ordered = [...r.rows].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < ordered.length; i++) assert.ok(ordered[i - 1].population >= ordered[i].population);
  assert.ok(r.rows.every((x) => x.rank <= r.rows.length && Number.isInteger(x.world_rank)));

  const snaps = await store.getRecentSnapshots(config.world, 10);
  const byTime = [...snaps].sort((a, b) => Date.parse(a.taken_at) - Date.parse(b.taken_at));
  const refSnap = byTime[byTime.length - 1 - 3];
  const both = [];
  for (const row of r.rows) {
    const then = store.playerHistory.find((h) => h.snapshot_id === refSnap.id && h.player_id === row.id);
    if (!then) {
      assert.equal(row.gain, null);
      assert.equal(row.rank_change, null);
      continue;
    }
    both.push({ row, then });
    assert.equal(row.population_then, then.population);
    assert.equal(row.gain, row.population - then.population);
    assert.equal(row.village_gain, row.villages - then.villages);
    assert.ok(Math.abs(row.gain_pct - row.gain / then.population) < 1e-12);
    if (!row.is_me && r.me.gain != null) {
      assert.equal(row.vs_me_pop, row.gain - r.me.gain);
      assert.ok(Math.abs(row.vs_me_pct - (row.gain_pct - r.me.gain_pct)) < 1e-12);
    }
  }
  assert.equal(r.me.vs_me_pct, null);

  // rank change = places gained among the players that existed at both times
  const placeNow = new Map([...both].sort((a, b) => b.row.population - a.row.population || a.row.world_rank - b.row.world_rank).map((x, i) => [x.row.id, i + 1]));
  const placeThen = new Map([...both].sort((a, b) => b.then.population - a.then.population || b.row.population - a.row.population || a.row.world_rank - b.row.world_rank).map((x, i) => [x.row.id, i + 1]));
  for (const { row } of both) assert.equal(row.rank_change, placeThen.get(row.id) - placeNow.get(row.id));

  // summary agrees with the rows
  const others = r.rows.filter((x) => !x.is_me && x.gain_pct != null);
  assert.equal(r.summary.compared, others.length);
  assert.equal(r.summary.faster + r.summary.slower + r.summary.same, others.length);
  assert.equal(r.summary.faster, others.filter((x) => x.gain_pct > r.me.gain_pct).length);
  assert.equal(r.summary.my_growth_position, 1 + r.summary.faster);
  assert.ok(r.summary.median_gain_pct != null);

  // chart series: the player first, then players of similar size, one aligned point per snapshot since the reference day
  assert.equal(r.series.times.length, 4);
  assert.equal(r.series.players[0].id, me.id);
  assert.equal(r.series.players[0].is_me, true);
  assert.ok(r.series.players.length <= 7);
  for (const p of r.series.players) assert.equal(p.points.length, r.series.times.length);
  assert.equal(r.series.players[0].points.at(-1), r.me.population);
});

test('the radius decides who is listed: a bigger radius only adds players, a tiny one leaves only you', async () => {
  const { store, config, world } = await ingestDays(2);
  const getMap = mapOf(store, config);
  const me = world.players.filter((p) => p.leftDay === null)[10];
  const at = async (radius) => (await buildCompare(store, config.world, { name: me.name, radius, origin: 'all', days: 1, getMap })).rows.map((r) => r.id);
  const small = await at(10);
  const medium = await at(30);
  const large = await at(80);
  assert.ok(small.every((id) => medium.includes(id)) && medium.every((id) => large.includes(id)));
  assert.ok(small.length <= medium.length && medium.length < large.length);
  const lonely = await buildCompare(store, config.world, { name: me.name, radius: 1, days: 1, getMap });
  assert.ok(lonely.rows.length >= 1 && lonely.rows.every((r) => r.is_me || r.distance <= 1));
  // the radius is clamped to something sensible
  assert.equal((await buildCompare(store, config.world, { name: me.name, radius: 9999, days: 1, getMap })).radius, 200);
  assert.equal((await buildCompare(store, config.world, { name: me.name, radius: -3, days: 1, getMap })).radius, 1);
  assert.equal((await buildCompare(store, config.world, { name: me.name, radius: 0, days: 1, getMap })).radius, 50); // 0 / missing = the default
});

test('by default the circle is drawn around the capital only, a subset of what all villages reach', async () => {
  const { store, config, world } = await ingestDays(1);
  const getMap = mapOf(store, config);
  const me = world.players.filter((p) => p.leftDay === null).sort((a, b) => b.villages.length - a.villages.length)[1];
  const all = await buildCompare(store, config.world, { name: me.name, radius: 30, origin: 'all', days: 1, getMap });
  const main = await buildCompare(store, config.world, { name: me.name, radius: 30, days: 1, getMap }); // the default
  assert.equal(all.origin, 'all');
  assert.equal(main.origin, 'main');
  const cap = main.location.main;
  assert.ok(main.rows.every((r) => r.is_me || (r.closest.you.x === cap.x && r.closest.you.y === cap.y && r.distance <= 30)));
  assert.ok(main.rows.every((r) => all.rows.some((a) => a.id === r.id))); // a subset
  assert.ok(main.rows.length < all.rows.length);
  assert.deepEqual(all.location, main.location); // your own location summary does not depend on the origin
});

test('when more players are in range than the cap allows, the nearest ones are kept', async () => {
  const { store, config, world } = await ingestDays(1);
  const getMap = mapOf(store, config);
  const me = world.players.filter((p) => p.leftDay === null)[4];
  const all = await buildCompare(store, config.world, { name: me.name, radius: 100, origin: 'all', days: 1, getMap });
  assert.ok(all.nearby.total > 6);
  const capped = await buildCompare(store, config.world, { name: me.name, radius: 100, origin: 'all', days: 1, getMap, maxNearby: 5 });
  assert.deepEqual(capped.nearby, { total: all.nearby.total, shown: 5, truncated: true });
  assert.equal(capped.rows.length, 6);
  const furthestKept = Math.max(...capped.rows.filter((r) => !r.is_me).map((r) => r.distance));
  const droppedNearer = all.rows.filter((r) => !r.is_me && !capped.rows.some((c) => c.id === r.id) && r.distance < furthestKept);
  assert.deepEqual(droppedNearer, []);
});

test('the reference day follows the requested period and reports truncated history', async () => {
  const { store, config } = await ingestDays(4);
  const getMap = mapOf(store, config);
  const someone = (await store.listPlayers(config.world, { sort: 'rank', limit: 1, offset: 10 })).rows[0];
  const day1 = await buildCompare(store, config.world, { name: someone.name, days: 1, getMap });
  assert.equal(day1.period.actual_days, 1);
  const all = await buildCompare(store, config.world, { name: someone.name, days: 0, getMap });
  assert.equal(all.period.actual_days, 4);
  assert.equal(all.period.requested_days, null);
  assert.equal(all.series.times.length, 5);
  const long = await buildCompare(store, config.world, { name: someone.name, days: 30, getMap });
  assert.equal(long.period.actual_days, 4);
  assert.equal(long.period.truncated, true);
});

test('with a single snapshot the nearby players are shown and growth is empty', async () => {
  const { store, config } = await ingestDays(0);
  const getMap = mapOf(store, config);
  const p = (await store.listPlayers(config.world, { sort: 'rank', limit: 1, offset: 5 })).rows[0];
  const r = await buildCompare(store, config.world, { name: p.name, radius: 60, days: 7, getMap });
  assert.equal(r.period, null);
  assert.equal(r.snapshots_stored, 1);
  assert.ok(r.rows.length > 1);
  assert.ok(r.rows.every((x) => x.gain === null && x.gain_pct === null && x.rank_change === null));
  assert.equal(r.summary.my_growth_position, null);
  assert.equal(r.series.times.length, 1);
});

test('without a usable village map the comparison says so instead of guessing', async () => {
  const { store, config } = await ingestDays(1);
  const p = (await store.listPlayers(config.world, { sort: 'rank', limit: 1, offset: 9 })).rows[0];
  for (const getMap of [null, async () => null, async () => ({ ver: 1, x: [] }), async () => { throw new Error('db down'); }]) {
    await assert.rejects(buildCompare(store, config.world, { name: p.name, days: 1, getMap }), (e) => e instanceof CompareError && e.status === 503 && /village map/.test(e.message));
  }
});

test('unknown names get suggestions; ids and case-insensitive names resolve', async () => {
  const { store, config } = await ingestDays(2);
  const getMap = mapOf(store, config);
  const p = (await store.listPlayers(config.world, { sort: 'rank', limit: 1, offset: 20 })).rows[0];

  const byId = await buildCompare(store, config.world, { name: String(p.id), days: 1, getMap });
  assert.equal(byId.me.id, p.id);
  const byName = await buildCompare(store, config.world, { name: `  ${p.name.toLowerCase()} `, days: 1, getMap });
  assert.equal(byName.me.id, p.id);

  const partial = p.name.slice(1, 4);
  await assert.rejects(buildCompare(store, config.world, { name: partial, days: 1, getMap }), (e) => {
    assert.ok(e instanceof CompareError);
    assert.equal(e.status, 404);
    assert.ok(e.extra.suggestions.length > 0);
    assert.ok(e.extra.suggestions.some((s) => s.id === p.id));
    return true;
  });
  await assert.rejects(buildCompare(store, config.world, { name: 'zzzz-nobody', days: 1, getMap }), (e) => e.status === 404 && e.extra.suggestions.length === 0);
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

    const ok = await get(`/api/compare?player=${encodeURIComponent(p.name)}&radius=40&days=1`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.me.id, p.id);
    assert.equal(ok.body.radius, 40);
    assert.ok(ok.body.rows.length >= 1);
    assert.ok(ok.body.rows.filter((x) => !x.is_me).every((x) => x.distance <= 40));
    assert.equal(ok.body.period.actual_days, 1);

    // default radius is 50 fields; out-of-range values are clamped, not rejected
    const dflt = await get(`/api/compare?player=${encodeURIComponent(p.name)}&days=abc`);
    assert.equal(dflt.status, 200);
    assert.equal(dflt.body.radius, 50);
    assert.equal(dflt.body.period.requested_days, 7);
    const big = await get(`/api/compare?player=${encodeURIComponent(p.name)}&radius=99999`);
    assert.equal(big.body.radius, 200);
    assert.equal(big.body.origin, 'main'); // default: around the capital
    assert.equal((await get(`/api/compare?player=${encodeURIComponent(p.name)}&origin=all`)).body.origin, 'all');
    assert.equal((await get(`/api/compare?player=${encodeURIComponent(p.name)}&origin=nonsense`)).body.origin, 'main');

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

    await store.getPlayersByIds('w', [5, 6, 7]);
    assert.equal(seen.at(-1).path, '/rest/v1/players');
    assert.equal(seen.at(-1).params.world, 'eq.w');
    assert.equal(seen.at(-1).params.id, 'in.(5,6,7)');
    const ids = Array.from({ length: 320 }, (_, i) => i + 1);
    const n0 = seen.length;
    await store.getPlayersByIds('w', ids);
    assert.equal(seen.length - n0, 3); // long id lists are split so the URL stays short

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
