'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../src/geo');
const { Ingestor } = require('../src/ingest');
const { MemoryStore } = require('../src/store/memory');
const { buildCompare } = require('../src/compare');
const { createApp } = require('../src/server');
const { createWorld, advance, toMapSql, silent, testConfig, fakeFetcher } = require('../scripts/test-helpers');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);
const R200 = geo.worldGeometry({ minX: -200, maxX: 200, minY: -200, maxY: 200 });

test('world size is inferred from the extent of the tiles and can be overridden', () => {
  assert.deepEqual(R200, { radius: 200, size: 401, wrap: true, source: 'inferred' });
  assert.equal(geo.worldGeometry({ minX: -150, maxX: 199, minY: -200, maxY: 120 }).radius, 200); // uses the widest edge
  assert.deepEqual(geo.worldGeometry(null, { radius: 400 }), { radius: 400, size: 801, wrap: true, source: 'configured' });
  assert.equal(geo.worldGeometry({ minX: -50, maxX: 50, minY: -50, maxY: 50 }, { radius: 200 }).radius, 200); // config wins
  assert.equal(geo.worldGeometry({ minX: -50, maxX: 50, minY: -50, maxY: 50 }, { wrap: false }).wrap, false);
  assert.deepEqual(geo.worldGeometry(null), { radius: null, size: null, wrap: false, source: 'unknown' });
});

test('distance is the straight line in fields and goes around the edge when that is shorter', () => {
  const d = (x1, y1, x2, y2, g = R200) => geo.distance(g, x1, y1, x2, y2);
  near(d(0, 0, 3, 4), 5);
  near(d(-10, 7, -10, 7), 0);
  near(d(-200, 0, 200, 0), 1); // neighbours across the seam
  near(d(-200, -200, 200, 200), Math.SQRT2); // diagonal across both seams
  near(d(-190, 0, 195, 0), 16); // 385 the long way, 401 - 385 = 16 around
  near(d(0, 0, 200, 0), 200); // the farthest possible along one axis
  near(d(0, 0, -200, 0), 200);
  // a world with hard edges does not wrap
  const flat = geo.worldGeometry({ minX: -200, maxX: 200, minY: -200, maxY: 200 }, { wrap: false });
  near(d(-200, 0, 200, 0, flat), 400);
  // symmetric, and never longer than the flat distance
  for (const [a, b, c, e] of [[5, 5, -190, 40], [-120, 130, 150, -150], [199, -199, -199, 199]]) {
    near(d(a, b, c, e), d(c, e, a, b));
    assert.ok(d(a, b, c, e) <= Math.hypot(a - c, b - e) + 1e-9);
  }
});

test('closest approach is the nearest pair of villages, also across the seam', () => {
  const a = [{ x: 0, y: 0 }, { x: -198, y: 10 }];
  const b = [{ x: 50, y: 50 }, { x: 199, y: 12 }, { x: 120, y: -80 }];
  const c = geo.closestApproach(R200, a, b);
  near(c.distance, Math.hypot(4, 2)); // (-198|10) to (199|12): 4 fields around the seam in x, 2 in y
  assert.deepEqual(c.from, { x: -198, y: 10 });
  assert.deepEqual(c.to, { x: 199, y: 12 });
  assert.equal(geo.closestApproach(R200, [], b), null);
  assert.equal(geo.closestApproach(R200, a, []), null);
});

test('centre of gravity: weighted by population and correct across the seam', () => {
  const one = geo.centre(R200, [{ x: 12, y: -30, pop: 400 }]);
  assert.deepEqual([one.x, one.y, one.spread, one.villages], [12, -30, 0, 1]);

  // two equal villages straddling the seam: the centre is at the seam, not in the middle of the map
  const seam = geo.centre(R200, [{ x: 199, y: 0, pop: 100 }, { x: -199, y: 0, pop: 100 }]);
  near(Math.abs(seam.x), 200.5, 0.11);
  near(seam.y, 0, 0.11);
  near(seam.spread, 1.5, 0.11);
  const plain = geo.centre(geo.worldGeometry({ minX: -200, maxX: 200, minY: -200, maxY: 200 }, { wrap: false }), [{ x: 199, y: 0, pop: 100 }, { x: -199, y: 0, pop: 100 }]);
  near(plain.x, 0); // without the wrap the same villages average to the middle of the map

  // the bigger village pulls the centre towards it
  const heavy = geo.centre(R200, [{ x: 0, y: 0, pop: 900 }, { x: 10, y: 0, pop: 100 }]);
  near(heavy.x, 1, 0.11);
  const even = geo.centre(R200, [{ x: 0, y: 0, pop: 500 }, { x: 10, y: 0, pop: 500 }]);
  near(even.x, 5, 0.11);
  assert.ok(heavy.spread < even.spread + 5); // both are tight groups

  // spread grows with scatter
  const tight = geo.centre(R200, [{ x: 0, y: 0, pop: 100 }, { x: 4, y: 0, pop: 100 }]);
  const wide = geo.centre(R200, [{ x: -60, y: 0, pop: 100 }, { x: 60, y: 0, pop: 100 }]);
  assert.ok(wide.spread > tight.spread * 10);
  near(wide.spread, 60, 0.11);

  // villages spread evenly around the whole world have no meaningful centre
  const ring = [-200, -100, 0, 100].map((x) => ({ x, y: 0, pop: 100 })); // a quarter of the world apart (100.25 fields)
  assert.equal(geo.centre(R200, ring), null);
  // ...but the same idea on a flat world is just an average
  assert.equal(geo.centre(geo.worldGeometry({ minX: -200, maxX: 200, minY: -200, maxY: 200 }, { wrap: false }), ring).x, -50);
  assert.equal(geo.centre(R200, []), null);

  // zero-population villages still count (weight at least 1)
  assert.deepEqual(geo.centre(R200, [{ x: 5, y: 5, pop: 0 }]).x, 5);
});

test('main village prefers the flagged capital, otherwise the biggest', () => {
  const v = [{ x: 1, y: 1, pop: 900, capital: false, name: 'a' }, { x: 2, y: 2, pop: 100, capital: true, name: 'b' }];
  assert.deepEqual(geo.mainVillage(v), { x: 2, y: 2, capital: true, name: 'b' });
  assert.deepEqual(geo.mainVillage([v[0]]), { x: 1, y: 1, capital: false, name: 'a' });
  assert.equal(geo.mainVillage([]), null);
});

// ---------------------------------------------------------------- integration with the comparison
async function setup(days = 3) {
  const config = testConfig();
  const store = new MemoryStore();
  const state = { text: '' };
  const world = createWorld({ seed: 55, radius: 60, players: 150, alliances: 6 });
  const ingestor = new Ingestor({ store, config, logger: silent, fetcher: fakeFetcher(state) });
  for (let d = 0; d <= days; d++) {
    if (d) advance(world);
    state.text = toMapSql(world);
    assert.equal((await ingestor.run()).status, 'ok');
  }
  const getMap = async () => (await store.getMap(config.world)).payload;
  return { config, store, world, getMap };
}

test('comparison distances match a brute-force calculation over the real village lists', async () => {
  const { config, store, world, getMap } = await setup();
  const rowsAll = (await store.listPlayers(config.world, { sort: 'rank', limit: 500 })).rows;
  const me = rowsAll[40];
  const r = await buildCompare(store, config.world, { name: me.name, above: 6, below: 6, days: 1, getMap });

  assert.deepEqual(r.geometry, { radius: 60, size: 121, wrap: true, source: 'inferred' });
  const g = geo.worldGeometry({ minX: -60, maxX: 60, minY: -60, maxY: 60 });
  const villagesOf = (id) => world.players.find((p) => p.id === id).villages;

  const mine = villagesOf(me.id);
  assert.equal(r.location.villages, mine.length);
  const myCentre = geo.centre(g, mine.map((v) => ({ x: v.x, y: v.y, pop: v.pop })));
  assert.deepEqual(r.location.centre, { x: myCentre.x, y: myCentre.y });
  assert.equal(r.location.spread, myCentre.spread);

  let checked = 0;
  for (const row of r.rows) {
    if (row.is_me) {
      assert.equal(row.distance, null);
      assert.equal(row.centre_distance, null);
      assert.ok(row.centre); // every player, including you, has a centre and a spread
      continue;
    }
    const theirs = villagesOf(row.id);
    let best = Infinity;
    for (const a of mine) for (const b of theirs) best = Math.min(best, geo.distance(g, a.x, a.y, b.x, b.y));
    assert.equal(row.distance, geo.round1(best));
    // the reported pair really is a pair of villages of the two players at that distance
    assert.ok(mine.some((v) => v.x === row.closest.you.x && v.y === row.closest.you.y));
    assert.ok(theirs.some((v) => v.x === row.closest.them.x && v.y === row.closest.them.y));
    near(geo.distance(g, row.closest.you.x, row.closest.you.y, row.closest.them.x, row.closest.them.y), best);

    const c = geo.centre(g, theirs.map((v) => ({ x: v.x, y: v.y, pop: v.pop })));
    assert.equal(row.spread, c.spread);
    assert.equal(row.centre_distance, geo.round1(geo.distance(g, myCentre.x, myCentre.y, c.x, c.y)));
    // the two measures are consistent: nobody's centres are closer than their closest villages minus their scatter
    assert.ok(row.distance <= row.centre_distance + row.spread + r.location.spread + 1);
    checked++;
  }
  assert.equal(checked, r.rows.length - 1);
});

test('without a usable map the comparison still works and distances stay empty', async () => {
  const { config, store } = await setup(1);
  const p = (await store.listPlayers(config.world, { sort: 'rank', limit: 1, offset: 9 })).rows[0];
  for (const getMap of [null, async () => null, async () => ({ ver: 1, x: [] }), async () => { throw new Error('db down'); }]) {
    const r = await buildCompare(store, config.world, { name: p.name, days: 1, getMap });
    assert.equal(r.geometry, null);
    assert.equal(r.location, null);
    assert.ok(r.rows.length > 1);
    assert.ok(r.rows.every((x) => x.distance === null && x.centre_distance === null && x.centre === null));
  }
});

test('MAP_RADIUS and MAP_WRAP change the geometry used by the API', async () => {
  const { config, store } = await setup(1);
  const app = createApp({ config: { ...config, mapRadius: 90, mapWrap: false }, store, logger: silent });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const p = (await store.listPlayers(config.world, { sort: 'rank', limit: 1, offset: 9 })).rows[0];
    const res = await fetch(`${base}/api/compare?player=${encodeURIComponent(p.name)}&days=1`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.geometry, { radius: 90, size: 181, wrap: false, source: 'configured' });
    assert.ok(body.rows.filter((x) => !x.is_me).every((x) => typeof x.distance === 'number' && x.distance >= 0));
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});
