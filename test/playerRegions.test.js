'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Ingestor } = require('../src/ingest');
const { MemoryStore } = require('../src/store/memory');
const { playerRegionBreakdown } = require('../src/regions');
const { createApp } = require('../src/server');
const { createWorld, advance, toMapSql, silent, testConfig, fakeFetcher } = require('../scripts/test-helpers');

// ---------------------------------------------------------------- playerRegionBreakdown (unit)
test('playerRegionBreakdown groups one player’s villages by region, shares them against the player’s own total, excludes Natars, and counts unregioned villages in the totals only', () => {
  const map = {
    // villages 0..4; rn[0]='East', rn[1]='West'; village 3 has no region (rg=-1); village 4 is a Natar village
    rg: [0, 0, 1, -1, 0],
    t: [1, 1, 1, 1, 5],
    p: [100, 50, 30, 20, 999],
    u: [0, 0, 0, 1, 2],
    pi: [111, 222, 999], // player index -> real player id (index 2 only ever appears on the Natar village)
    rn: ['East', 'West'],
  };

  const mine = playerRegionBreakdown(map, 111);
  assert.equal(mine.villages, 3);
  assert.equal(mine.population, 180);
  assert.deepEqual(mine.regions, [
    { region: 'East', villages: 2, population: 150, village_share: 2 / 3, population_share: 150 / 180 },
    { region: 'West', villages: 1, population: 30, village_share: 1 / 3, population_share: 30 / 180 },
  ]);

  // player 222's only village has no region: it still counts toward the totals, just not toward any region row
  const other = playerRegionBreakdown(map, 222);
  assert.deepEqual(other, { regions: [], villages: 1, population: 20 });

  // Natars are excluded even though pi[2] === 999 matches village 4's owner
  assert.deepEqual(playerRegionBreakdown(map, 999), { regions: [], villages: 0, population: 0 });
  assert.deepEqual(playerRegionBreakdown(map, 555), { regions: [], villages: 0, population: 0 }); // unknown player

  assert.equal(playerRegionBreakdown(null, 111), null);
  assert.equal(playerRegionBreakdown({ ver: 1 }, 111), null); // pre-ver-3 map: no rg/rn/u/pi arrays
});

// ---------------------------------------------------------------- GET /api/players/:id
test('GET /api/players/:id includes a live per-region population breakdown for the player', async () => {
  const config = testConfig();
  const store = new MemoryStore();
  const state = { text: '' };
  const world = createWorld({ seed: 83, players: 150, alliances: 7, regions: true });
  const ingestor = new Ingestor({ store, config, logger: silent, fetcher: fakeFetcher(state) });
  for (let d = 0; d <= 2; d++) {
    if (d) advance(world);
    state.text = toMapSql(world);
    assert.equal((await ingestor.run()).status, 'ok');
  }

  const app = createApp({ config, store, logger: silent });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    // pick a real player who owns villages in more than one region, straight off the world fixture
    const quadrantOf = (x, y) => (y >= 0 ? (x >= 0 ? 'Northeast' : 'Northwest') : x >= 0 ? 'Southeast' : 'Southwest');
    const candidate = world.players.find((p) => p.leftDay === null && new Set(p.villages.map((v) => quadrantOf(v.x, v.y))).size > 1) || world.players.find((p) => p.leftDay === null);
    const expectedByRegion = new Map();
    let expectedVillages = 0;
    let expectedPopulation = 0;
    for (const v of candidate.villages) {
      expectedVillages++;
      expectedPopulation += v.pop;
      const r = quadrantOf(v.x, v.y);
      expectedByRegion.set(r, (expectedByRegion.get(r) || 0) + v.pop);
    }

    const res = await fetch(`${base}/api/players/${candidate.id}`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.regions_available, true);
    assert.equal(body.player.villages, expectedVillages);
    assert.equal(body.player.population, expectedPopulation);
    assert.equal(body.regions.length, expectedByRegion.size);
    for (const r of body.regions) {
      assert.equal(r.population, expectedByRegion.get(r.region));
      assert.equal(r.population_share, expectedPopulation ? r.population / expectedPopulation : 0);
    }
    // sorted by population descending
    for (let i = 1; i < body.regions.length; i++) assert.ok(body.regions[i - 1].population >= body.regions[i].population);

    assert.equal((await (await fetch(`${base}/api/players/999999`)).json()).error, 'Player not found');
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});
