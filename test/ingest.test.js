'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Ingestor } = require('../src/ingest');
const { MemoryStore } = require('../src/store/memory');
const { buildOverview, buildHistory } = require('../src/views');
const { createWorld, advance, toMapSql, silent, testConfig, fakeFetcher } = require('../scripts/test-helpers');

function setup() {
  const config = testConfig();
  const store = new MemoryStore();
  const state = { text: '' };
  const fetcher = fakeFetcher(state);
  const ingestor = new Ingestor({ store, config, logger: silent, fetcher });
  const world = createWorld({ seed: 11, players: 150, alliances: 8 });
  state.text = toMapSql(world);
  return { config, store, state, fetcher, ingestor, world };
}

test('first ingest stores a snapshot, an identical file is reported as unchanged', async () => {
  const { ingestor, store, config, world } = setup();
  const r1 = await ingestor.run();
  assert.equal(r1.status, 'ok', r1.message);
  const [snap] = await store.getRecentSnapshots(config.world, 1);
  assert.equal(snap.players, world.players.length);
  assert.equal(snap.new_players, 0); // no baseline on the first snapshot

  const r2 = await ingestor.run();
  assert.equal(r2.status, 'unchanged');
  assert.equal((await store.getRecentSnapshots(config.world, 5)).length, 1);
});

test('conditional GET headers are sent and a 304 is handled', async () => {
  const { ingestor, state, fetcher } = setup();
  state.etag = '"abc"';
  state.lastModified = '2026-09-24T00:00:00.000Z';
  assert.equal((await ingestor.run()).status, 'ok');
  state.notModified = true;
  const r = await ingestor.run();
  assert.equal(r.status, 'unchanged');
  assert.equal(fetcher.calls.at(-1).opts.etag, '"abc"');
});

test('a new day produces deltas, new/departed players, movers and history', async () => {
  const { ingestor, state, store, config, world } = setup();
  await ingestor.run();
  const day0Ids = new Set(world.players.map((p) => p.id));
  for (let d = 0; d < 3; d++) {
    advance(world);
    state.text = toMapSql(world);
    const r = await ingestor.run();
    assert.equal(r.status, 'ok', r.message);
  }
  const ov = await buildOverview(store, config.world);
  const active = world.players.filter((p) => p.leftDay === null);
  assert.equal(ov.totals.players, active.length);
  assert.ok(ov.deltas.population > 0);
  assert.ok(ov.deltas.villages >= 0);
  assert.equal(ov.tribes.filter((t) => t.tribe !== 5).reduce((s, t) => s + t.players, 0), active.length);
  assert.ok(ov.gainers.length > 0 && ov.gainers[0].pop_delta > 0);
  assert.equal(ov.top_players[0].rank, 1);
  assert.ok(ov.top_players[0].population >= ov.top_players[1].population);

  const hist = await buildHistory(store, config.world, {});
  assert.equal(hist.snapshots.length, 4);
  assert.ok(hist.tribes.length >= 5);
  assert.equal(hist.tribes[0].points.length, 4);
  assert.equal(hist.alliances.length, 5);
  assert.equal(hist.alliances[0].points.length, 4);

  // players that left disappear from the current table
  const gone = world.players.filter((p) => p.leftDay !== null && day0Ids.has(p.id));
  for (const g of gone) assert.equal(await store.getPlayer(config.world, g.id), null);
});

test('bad downloads are rejected without touching stored data', async () => {
  const { ingestor, state, store, config, world } = setup();
  await ingestor.run();
  const good = state.text;

  state.text = '<html><body>Server maintenance</body></html>';
  let r = await ingestor.run();
  assert.equal(r.status, 'error');
  assert.match(r.message, /HTML/);

  state.text = 'not sql at all';
  r = await ingestor.run();
  assert.equal(r.status, 'error');
  assert.match(r.message, /No x_world rows/);

  advance(world);
  const lines = toMapSql(world).split('\n');
  state.text = lines.slice(0, Math.floor(lines.length / 3)).join('\n');
  r = await ingestor.run();
  assert.equal(r.status, 'error');
  assert.match(r.message, /Refusing to ingest/);

  state.error = 'connect ECONNRESET';
  r = await ingestor.run();
  assert.equal(r.status, 'error');
  assert.match(r.message, /ECONNRESET/);

  assert.equal((await store.getRecentSnapshots(config.world, 5)).length, 1);
  assert.ok(good.length > 0);
  const log = await store.getIngestLog(config.world, 10);
  assert.equal(log.filter((l) => l.status === 'error').length, 4);
});

test('maybeRefresh only downloads when the last snapshot is old enough', async () => {
  const { ingestor, store, fetcher, state, world } = setup();
  assert.equal((await ingestor.maybeRefresh()).status, 'ok'); // empty store: due immediately
  const calls = fetcher.calls.length;

  ingestor.lastCheckAt = 0;
  ingestor.lastAttemptAt = 0;
  assert.equal(await ingestor.maybeRefresh(), null); // fresh snapshot: nothing to do
  assert.equal(fetcher.calls.length, calls);

  store.snapshots[0].taken_at = new Date(Date.now() - 21 * 3600 * 1000).toISOString();
  ingestor.lastCheckAt = 0;
  ingestor.lastAttemptAt = 0;
  advance(world);
  state.text = toMapSql(world);
  assert.equal((await ingestor.maybeRefresh()).status, 'ok');

  // after a failure it waits for the retry interval
  state.error = 'boom';
  store.snapshots[1].taken_at = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  ingestor.lastCheckAt = 0;
  ingestor.lastAttemptAt = 0;
  assert.equal((await ingestor.maybeRefresh()).status, 'error');
  ingestor.lastCheckAt = 0;
  assert.equal(await ingestor.maybeRefresh(), null);
});
