'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Ingestor } = require('../src/ingest');
const { MemoryStore } = require('../src/store/memory');
const { buildRegionDetail, regionAllianceBreakdown } = require('../src/regions');
const { CompareError } = require('../src/compare');
const { createApp } = require('../src/server');
const { createWorld, advance, toMapSql, silent, testConfig, fakeFetcher } = require('../scripts/test-helpers');

const DAY = 86400000;

/** Ingests `days + 1` daily snapshots and spaces their timestamps exactly one day apart (oldest first). */
async function ingestDays(days, over = {}) {
  const config = testConfig(over);
  const store = new MemoryStore();
  const state = { text: '' };
  const world = createWorld({ seed: 61, players: 180, alliances: 9, regions: true });
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
  const getMap = async () => (await store.getMap(config.world)).payload;
  return { config, store, world, getMap };
}

// ---------------------------------------------------------------- regionAllianceBreakdown (unit)
test('regionAllianceBreakdown groups a region by alliance, buckets the unaffiliated, and excludes Natars', () => {
  const map = {
    // villages 0..5; rn[0]='East', rn[1]='West'
    rg: [0, 0, 0, 0, 1, 0],
    t: [1, 1, 1, 1, 1, 5], // village 5 is a Natar village in 'East'
    p: [100, 50, 30, 20, 999, 500],
    a: [0, 0, 1, -1, -1, -1], // village indexes into ai/at; -1 = no alliance
    ai: [10, 20],
    at: ['ONE', 'TWO'],
    rn: ['East', 'West'],
  };
  const east = regionAllianceBreakdown(map, 'East');
  assert.equal(east.villages, 4); // 5 East villages minus the Natar one
  assert.equal(east.population, 200); // 100+50+30+20, the Natar's 500 excluded
  assert.deepEqual(
    east.alliances.map((a) => [a.alliance_id, a.villages, a.population]),
    [[10, 2, 150], [null, 1, 20], [20, 1, 30]].sort((x, y) => y[2] - x[2]),
  );
  const one = east.alliances.find((a) => a.alliance_id === 10);
  assert.equal(one.village_share, 2 / 4);
  assert.ok(Math.abs(one.population_share - 150 / 200) < 1e-9);
  const none = east.alliances.find((a) => a.alliance_id === null);
  assert.equal(none.alliance_tag, null);

  const west = regionAllianceBreakdown(map, 'West');
  assert.deepEqual(west, { villages: 1, population: 999, alliances: [{ alliance_id: null, alliance_tag: null, villages: 1, population: 999, village_share: 1, population_share: 1 }] });

  assert.deepEqual(regionAllianceBreakdown(map, 'Nowhere'), { villages: 0, population: 0, alliances: [] });
  assert.equal(regionAllianceBreakdown(null, 'East'), null);
  assert.equal(regionAllianceBreakdown({ ver: 1 }, 'East'), null); // pre-ver-3 map: no rg/rn arrays
});

// ---------------------------------------------------------------- buildRegionDetail (integration)
test('buildRegionDetail: totals, growth over 1/3/7 days and the live alliance breakdown all check out', async () => {
  const { config, store, world, getMap } = await ingestDays(7);
  const map = await getMap();
  assert.equal(map.ver, 3);

  const series = await store.getSnapshotSeries(config.world, 400);
  const b = (kind) => store.breakdowns.filter((r) => r.snapshot_id === series[series.length - 1].id && r.kind === kind);
  const key = b('region').sort((x, y) => y.villages - x.villages)[0].key; // the biggest region right now

  const d = await buildRegionDetail(store, config.world, key, { getMap });
  assert.equal(d.region, key);
  assert.equal(d.regions_tracked, 4);
  assert.equal(d.rank, [...b('region')].sort((x, y) => y.villages - x.villages).findIndex((r) => r.key === key) + 1);

  const latestRow = b('region').find((r) => r.key === key);
  assert.equal(d.totals.villages, latestRow.villages);
  assert.equal(d.totals.population, Number(latestRow.population));
  assert.ok(Math.abs(d.totals.avg_population - Number(latestRow.population) / latestRow.villages) < 1e-9);
  assert.equal(d.history.length, series.length);
  assert.equal(d.history.at(-1).population, d.totals.population);

  // growth: cross-check against the region's own row 1 / 3 / 7 daily snapshots back (they are spaced exactly a day apart)
  for (const [field, daysBack] of [['d1', 1], ['d3', 3], ['d7', 7]]) {
    const past = store.breakdowns.find((r) => r.snapshot_id === series[series.length - 1 - daysBack].id && r.kind === 'region' && r.key === key);
    const g = d.growth[field];
    assert.ok(g, field);
    assert.equal(g.villages_gain, d.totals.villages - past.villages);
    assert.equal(g.population_gain, d.totals.population - Number(past.population));
    assert.equal(g.actual_days, daysBack);
    assert.equal(g.truncated, false);
  }

  // live alliance breakdown: brute force from the world itself, using the same East/West/North/South quadrant rule as the fixture
  const quadrantOf = (x, y) => (y >= 0 ? (x >= 0 ? 'Northeast' : 'Northwest') : x >= 0 ? 'Southeast' : 'Southwest');
  const byAlliance = new Map();
  let villages = 0;
  let population = 0;
  for (const p of world.players) {
    if (p.leftDay !== null) continue;
    for (const v of p.villages) {
      if (quadrantOf(v.x, v.y) !== key) continue;
      villages++;
      population += v.pop;
      const bucketKey = p.alliance ? p.alliance.id : 'none';
      const cur = byAlliance.get(bucketKey) || { villages: 0, population: 0 };
      cur.villages++;
      cur.population += v.pop;
      byAlliance.set(bucketKey, cur);
    }
  }
  assert.equal(d.alliances_available, true);
  const sumV = d.alliances.reduce((s, a) => s + a.villages, 0);
  const sumP = d.alliances.reduce((s, a) => s + a.population, 0);
  assert.equal(sumV, villages);
  assert.equal(sumP, population);
  for (const a of d.alliances) {
    const expected = byAlliance.get(a.alliance_id ?? 'none');
    assert.deepEqual({ villages: a.villages, population: a.population }, expected);
  }
  // sorted by population descending
  for (let i = 1; i < d.alliances.length; i++) assert.ok(d.alliances[i - 1].population >= d.alliances[i].population);
});

test('buildRegionDetail: with a single snapshot growth is null everywhere; without a usable map the alliance table is unavailable', async () => {
  const { config, store } = await ingestDays(0);
  const series = await store.getSnapshotSeries(config.world, 1);
  const key = store.breakdowns.find((r) => r.snapshot_id === series[0].id && r.kind === 'region').key;

  const alone = await buildRegionDetail(store, config.world, key, { getMap: null });
  assert.deepEqual(alone.growth, { d1: null, d3: null, d7: null });
  assert.equal(alone.alliances_available, false);
  assert.deepEqual(alone.alliances, []);

  for (const getMap of [async () => null, async () => ({ ver: 1 }), async () => { throw new Error('db down'); }]) {
    const r = await buildRegionDetail(store, config.world, key, { getMap });
    assert.equal(r.alliances_available, false);
    assert.deepEqual(r.alliances, []);
    assert.ok(r.totals.villages > 0); // the region totals do not depend on the map at all
  }
});

test('buildRegionDetail rejects an unknown region and a world with no stored snapshot', async () => {
  const { config, store } = await ingestDays(1);
  await assert.rejects(buildRegionDetail(store, config.world, 'Nowhereland', {}), (e) => e instanceof CompareError && e.status === 404 && /No region named/.test(e.message));

  const empty = new MemoryStore();
  await assert.rejects(buildRegionDetail(empty, testConfig().world, 'East', {}), (e) => e instanceof CompareError && e.status === 503);
});

// ---------------------------------------------------------------- GET /api/regions
test('GET /api/regions validates input and returns the region detail', async () => {
  const { config, store } = await ingestDays(3);
  const app = createApp({ config, store, logger: silent });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.equal((await get('/api/regions')).status, 400);
    assert.equal((await get('/api/regions?key=%20%20')).status, 400);

    const missing = await get('/api/regions?key=Nowhereland');
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /No region named/);

    const series = await store.getSnapshotSeries(config.world, 1);
    const key = store.breakdowns.find((r) => r.snapshot_id === series[0].id && r.kind === 'region').key;
    const ok = await get(`/api/regions?key=${encodeURIComponent(key)}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.region, key);
    assert.equal(ok.body.alliances_available, true);
    assert.ok(ok.body.alliances.every((a) => typeof a.villages === 'number' && typeof a.population_share === 'number'));
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});
