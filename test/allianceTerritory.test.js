'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Ingestor } = require('../src/ingest');
const { MemoryStore } = require('../src/store/memory');
const { buildAllianceTerritory, allianceRegionBreakdown } = require('../src/regions');
const { regionAllianceKey } = require('../src/aggregate');
const { CompareError } = require('../src/compare');
const { createApp } = require('../src/server');
const { createWorld, advance, toMapSql, silent, testConfig, fakeFetcher } = require('../scripts/test-helpers');

const DAY = 86400000;

/** Ingests `days + 1` daily snapshots and spaces their timestamps exactly one day apart (oldest first). */
async function ingestDays(days, over = {}) {
  const config = testConfig(over);
  const store = new MemoryStore();
  const state = { text: '' };
  const world = createWorld({ seed: 71, players: 180, alliances: 9, regions: true });
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

// ---------------------------------------------------------------- allianceRegionBreakdown (unit)
test('allianceRegionBreakdown groups one alliance’s villages by region and shares them against each region’s own total, excluding Natars', () => {
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
  const mine = allianceRegionBreakdown(map, 10);
  assert.deepEqual(mine.regions, [{ region: 'East', villages: 2, population: 150, village_share: 2 / 4, population_share: 150 / 200 }]);

  const other = allianceRegionBreakdown(map, 20);
  assert.deepEqual(other.regions, [{ region: 'East', villages: 1, population: 30, village_share: 1 / 4, population_share: 30 / 200 }]);

  assert.deepEqual(allianceRegionBreakdown(map, 999), { regions: [] }); // no villages anywhere
  assert.equal(allianceRegionBreakdown(null, 10), null);
  assert.equal(allianceRegionBreakdown({ ver: 1 }, 10), null); // pre-ver-3 map: no rg/rn arrays
});

// ---------------------------------------------------------------- buildAllianceTerritory (integration)
test('buildAllianceTerritory: totals, the alliance’s own growth, and its live per-region breakdown (with per-region growth) all check out', async () => {
  const { config, store, world, getMap } = await ingestDays(7);
  const map = await getMap();

  // pick the alliance with the most population right now, straight off the world fixture
  const byAlliance = new Map();
  const quadrantOf = (x, y) => (y >= 0 ? (x >= 0 ? 'Northeast' : 'Northwest') : x >= 0 ? 'Southeast' : 'Southwest');
  for (const p of world.players) {
    if (p.leftDay !== null || !p.alliance) continue;
    const cur = byAlliance.get(p.alliance.id) || { villages: 0, population: 0, byRegion: new Map() };
    for (const v of p.villages) {
      cur.villages++;
      cur.population += v.pop;
      const r = quadrantOf(v.x, v.y);
      cur.byRegion.set(r, (cur.byRegion.get(r) || 0) + v.pop);
    }
    byAlliance.set(p.alliance.id, cur);
  }
  const allianceId = [...byAlliance.entries()].sort((a, b) => b[1].population - a[1].population)[0][0];
  const expected = byAlliance.get(allianceId);

  const d = await buildAllianceTerritory(store, config.world, allianceId, { getMap });
  const stored = await store.getAlliance(config.world, allianceId);
  assert.equal(d.alliance_tag, stored.tag);
  assert.deepEqual(d.totals, { members: stored.members, villages: stored.villages, population: stored.population });
  assert.equal(d.totals.villages, expected.villages);
  assert.equal(d.totals.population, expected.population);

  assert.equal(d.regions_available, true);
  assert.equal(d.regions.length, expected.byRegion.size);
  for (const r of d.regions) assert.equal(r.population, expected.byRegion.get(r.region));
  // sorted by population descending
  for (let i = 1; i < d.regions.length; i++) assert.ok(d.regions[i - 1].population >= d.regions[i].population);

  // the alliance's own growth (from alliance_history, same series the ordinary alliance dialog uses)
  const series = await store.getSnapshotSeries(config.world, 400);
  for (const [field, daysBack] of [['d1', 1], ['d3', 3], ['d7', 7]]) {
    const past = store.allianceHistory.find((r) => r.snapshot_id === series[series.length - 1 - daysBack].id && r.alliance_id === allianceId);
    const g = d.growth[field];
    assert.ok(g, field);
    assert.equal(g.population_gain, d.totals.population - past.population);
    assert.equal(g.actual_days, daysBack);
    assert.equal(g.ref_snapshot_id, past.snapshot_id);
  }

  // per-region growth: cross-check against the stored region_alliance rows at those same reference snapshots
  for (const [field, daysBack] of [['d1', 1], ['d3', 3], ['d7', 7]]) {
    const refSnapshotId = series[series.length - 1 - daysBack].id;
    for (const r of d.regions) {
      const past = store.breakdowns.find((row) => row.snapshot_id === refSnapshotId && row.kind === 'region_alliance' && row.key === regionAllianceKey(r.region, allianceId));
      const g = r.growth[field];
      if (!past) {
        assert.equal(g, null, `${r.region} ${field}`);
        continue;
      }
      assert.ok(g, `${r.region} ${field}`);
      assert.equal(g.population_gain, r.population - Number(past.population));
      const expectedPct = Number(past.population) > 0 ? (r.population - Number(past.population)) / Number(past.population) : null;
      assert.equal(g.population_gain_pct, expectedPct);
    }
  }
});

test('buildAllianceTerritory: with a single snapshot growth is null everywhere (alliance and per-region alike); without a usable map the control table is unavailable', async () => {
  const { config, store, world } = await ingestDays(0);
  const allianceId = world.alliances[0].id;

  const alone = await buildAllianceTerritory(store, config.world, allianceId, { getMap: null });
  assert.deepEqual(alone.growth, { d1: null, d3: null, d7: null });
  assert.equal(alone.regions_available, false);
  assert.deepEqual(alone.regions, []);

  const getMap = async () => (await store.getMap(config.world)).payload;
  const withMap = await buildAllianceTerritory(store, config.world, allianceId, { getMap });
  assert.equal(withMap.regions_available, true);
  for (const r of withMap.regions) assert.deepEqual(r.growth, { d1: null, d3: null, d7: null }); // one snapshot: no reference point

  for (const badMap of [async () => null, async () => ({ ver: 1 }), async () => { throw new Error('db down'); }]) {
    const r = await buildAllianceTerritory(store, config.world, allianceId, { getMap: badMap });
    assert.equal(r.regions_available, false);
    assert.deepEqual(r.regions, []);
    assert.ok(r.totals.population >= 0); // totals do not depend on the map at all
  }
});

test('buildAllianceTerritory rejects an unknown alliance and a world with no stored snapshot', async () => {
  const { config, store, world } = await ingestDays(1);
  await assert.rejects(buildAllianceTerritory(store, config.world, 999999, {}), (e) => e instanceof CompareError && e.status === 404 && /No alliance/.test(e.message));

  const empty = new MemoryStore();
  await assert.rejects(buildAllianceTerritory(empty, testConfig().world, world.alliances[0].id, {}), (e) => e instanceof CompareError && e.status === 503);
});

// ---------------------------------------------------------------- GET /api/alliance-regions
test('GET /api/alliance-regions validates input and returns the territory detail', async () => {
  const { config, store, world } = await ingestDays(3);
  const app = createApp({ config, store, logger: silent });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.equal((await get('/api/alliance-regions')).status, 400);
    assert.equal((await get('/api/alliance-regions?id=abc')).status, 400);
    assert.equal((await get('/api/alliance-regions?id=0')).status, 400);
    assert.equal((await get('/api/alliance-regions?id=-5')).status, 400);

    const missing = await get('/api/alliance-regions?id=999999');
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /No alliance/);

    const allianceId = world.alliances[0].id;
    const ok = await get(`/api/alliance-regions?id=${allianceId}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.alliance_id, allianceId);
    assert.ok(ok.body.regions.every((r) => r.growth && ['d1', 'd3', 'd7'].every((h) => h in r.growth)));
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});
