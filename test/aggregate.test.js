'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMapSql } = require('../src/parser');
const { aggregate, regionAllianceKey, REGION_ALLIANCE_SEP, REGION_ALLIANCE_CAP } = require('../src/aggregate');
const { createWorld, toMapSql } = require('../scripts/fixture');

function build(opts) {
  const world = createWorld(opts);
  const { rows } = parseMapSql(toMapSql(world));
  return { world, rows, agg: aggregate(rows) };
}

test('totals match the generated world; Natars and unoccupied tiles are excluded from player stats', () => {
  const { world, rows, agg } = build({ seed: 3, players: 200, alliances: 8, regions: true });
  const { totals } = agg.payload;
  const villages = world.players.reduce((s, p) => s + p.villages.length, 0);
  const population = world.players.reduce((s, p) => s + p.villages.reduce((a, v) => a + v.pop, 0), 0);
  assert.equal(totals.tiles, rows.length);
  assert.equal(totals.players, world.players.length);
  assert.equal(totals.villages, villages);
  assert.equal(totals.population, population);
  assert.equal(totals.natar_villages, world.natars.length);
  assert.equal(totals.capitals, world.players.length);
  assert.equal(agg.payload.players.reduce((s, p) => s + p.population, 0), population);
  assert.ok(!agg.payload.players.some((p) => p.tribe === 5));
});

test('alliance and tribe aggregates are consistent', () => {
  const { agg } = build({ seed: 5, players: 250, alliances: 10 });
  const { payload } = agg;
  const inAlliance = payload.players.filter((p) => p.alliance_id != null);
  assert.equal(payload.totals.players_in_alliance, inAlliance.length);
  assert.equal(payload.alliances.reduce((s, a) => s + a.members, 0), inAlliance.length);
  assert.equal(payload.alliances.reduce((s, a) => s + a.population, 0), inAlliance.reduce((s, p) => s + p.population, 0));
  const playerTribes = payload.tribes.filter((t) => t.tribe !== 5);
  assert.equal(playerTribes.reduce((s, t) => s + t.players, 0), payload.totals.players);
  assert.equal(playerTribes.reduce((s, t) => s + t.villages, 0), payload.totals.villages);
  assert.equal(payload.tribes.find((t) => t.tribe === 5).villages, payload.totals.natar_villages);
});

test('distributions add up and the compact map covers every occupied village', () => {
  const { agg } = build({ seed: 9, players: 180, alliances: 6, regions: true });
  const { meta, totals } = agg.payload;
  assert.equal(meta.pop_buckets.reduce((s, b) => s + b.count, 0), totals.players);
  assert.equal(meta.village_buckets.reduce((s, b) => s + b.count, 0), totals.players);
  const q = meta.quadrants;
  assert.equal(q.NE.villages + q.NW.villages + q.SE.villages + q.SW.villages, totals.villages);
  assert.equal(meta.rings.items.reduce((s, r) => s + r.villages, 0), totals.villages);
  assert.ok(meta.concentration.top10 > 0 && meta.concentration.top10 <= meta.concentration.top100 && meta.concentration.top100 <= 1);
  assert.equal(agg.map.count, totals.villages + totals.natar_villages);
  for (const k of ['x', 'y', 't', 'p', 'u', 'a', 'f', 'n']) assert.equal(agg.map[k].length, agg.map.count);
  assert.equal(meta.regions.length, 4);
});

test('the compact map (ver 3) carries a region index per village that reproduces the region totals (Natars excluded)', () => {
  const { agg } = build({ seed: 11, players: 160, alliances: 7, regions: true });
  const { map, payload } = agg;
  assert.equal(map.ver, 3);
  assert.equal(map.rg.length, map.count);
  assert.ok(map.rg.every((ri) => ri === -1 || (ri >= 0 && ri < map.rn.length)));
  assert.deepEqual([...map.rn].sort(), ['Northeast', 'Northwest', 'Southeast', 'Southwest']);

  // re-derive villages/population per region straight from the compact map, the same way regions.js does
  const NATAR_TRIBE = 5;
  const byRegion = new Map();
  for (let i = 0; i < map.count; i++) {
    if (map.t[i] === NATAR_TRIBE || map.rg[i] === -1) continue;
    const key = map.rn[map.rg[i]];
    const r = byRegion.get(key) || { villages: 0, population: 0 };
    r.villages++;
    r.population += map.p[i];
    byRegion.set(key, r);
  }
  for (const r of payload.meta.regions) {
    assert.deepEqual(byRegion.get(r.region), { villages: r.villages, population: r.population });
  }
  assert.equal([...byRegion.values()].reduce((s, r) => s + r.villages, 0), payload.totals.villages);

  // a world without regions gets no region names at all, but the array is still present (ver 3 shape)
  const flat = build({ seed: 12, players: 40, alliances: 3, regions: false });
  assert.deepEqual(flat.agg.map.rn, []);
  assert.ok(flat.agg.map.rg.every((ri) => ri === -1));
});

test('region_alliance breakdown rows (which alliances hold a region) reproduce the live map, are capped per region, and only exist for tracked regions', () => {
  const { agg } = build({ seed: 13, players: 220, alliances: 12, regions: true });
  const { payload, map } = agg;
  const regionRows = payload.breakdowns.filter((b) => b.kind === 'region');
  const raRows = payload.breakdowns.filter((b) => b.kind === 'region_alliance');
  assert.ok(raRows.length > 0);

  // every region_alliance row's key decodes to a region that also has its own 'region' row, and the
  // numeric alliance id in `lo` matches what's encoded in the key
  const regionKeys = new Set(regionRows.map((r) => r.key));
  for (const r of raRows) {
    const sep = r.key.lastIndexOf(REGION_ALLIANCE_SEP);
    assert.ok(sep > -1, r.key);
    const region = r.key.slice(0, sep);
    const allianceIdPart = r.key.slice(sep + 1);
    assert.ok(regionKeys.has(region), region);
    assert.equal(r.key, regionAllianceKey(region, r.lo));
    if (allianceIdPart === 'none') assert.equal(r.lo, null);
    else assert.equal(String(r.lo), allianceIdPart);
  }

  // capped per region
  const perRegion = new Map();
  for (const r of raRows) {
    const region = r.key.slice(0, r.key.lastIndexOf(REGION_ALLIANCE_SEP));
    perRegion.set(region, (perRegion.get(region) || 0) + 1);
  }
  for (const n of perRegion.values()) assert.ok(n <= REGION_ALLIANCE_CAP);

  // re-derive each region's alliance breakdown straight off the compact map (same way regions.js does) and
  // check it matches the stored rows exactly, since with only 12 alliances every region here is under the cap
  const NATAR_TRIBE = 5;
  const byRaKey = new Map();
  for (let i = 0; i < map.count; i++) {
    if (map.t[i] === NATAR_TRIBE || map.rg[i] === -1) continue;
    const region = map.rn[map.rg[i]];
    const a = map.a[i];
    const allianceId = a >= 0 ? map.ai[a] : null;
    const key = regionAllianceKey(region, allianceId);
    const cur = byRaKey.get(key) || { villages: 0, population: 0 };
    cur.villages++;
    cur.population += map.p[i];
    byRaKey.set(key, cur);
  }
  for (const r of raRows) {
    assert.deepEqual(byRaKey.get(r.key), { villages: r.villages, population: r.population });
  }
  assert.equal(raRows.length, byRaKey.size);

  // a world without regions produces no region_alliance rows either
  const flat = build({ seed: 14, players: 40, alliances: 3, regions: false });
  assert.equal(flat.agg.payload.breakdowns.filter((b) => b.kind === 'region_alliance').length, 0);
});
