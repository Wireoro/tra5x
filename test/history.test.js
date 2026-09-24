'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Ingestor } = require('../src/ingest');
const { MemoryStore } = require('../src/store/memory');
const { SupabaseStore } = require('../src/store/supabase');
const { PostgrestClient } = require('../src/store/postgrest');
const { aggregate } = require('../src/aggregate');
const { parseMapSql } = require('../src/parser');
const { diffVillages } = require('../src/events');
const { createApp } = require('../src/server');
const { createWorld, advance, toMapSql, silent, testConfig, fakeFetcher } = require('../scripts/test-helpers');

const mapOf = (world) => aggregate(parseMapSql(toMapSql(world)).rows).map;

async function ingestDays(days, over = {}) {
  const config = testConfig(over);
  const store = new MemoryStore();
  const state = { text: '' };
  const world = createWorld({ seed: 33, players: 220, alliances: 8, regions: true });
  const ingestor = new Ingestor({ store, config, logger: silent, fetcher: fakeFetcher(state) });
  for (let d = 0; d <= days; d++) {
    if (d) advance(world);
    state.text = toMapSql(world);
    const r = await ingestor.run();
    assert.equal(r.status, 'ok', r.message);
  }
  return { config, store, world, ingestor };
}

test('diffVillages finds founded, conquered and abandoned villages', () => {
  const w = createWorld({ seed: 5, players: 60, alliances: 4 });
  const before = mapOf(w);

  const victim = w.players.find((p) => p.villages.length >= 2);
  const attacker = w.players.find((p) => p !== victim);
  const conquered = victim.villages.splice(victim.villages.findIndex((v) => !v.capital), 1)[0];
  attacker.villages.push(conquered);

  const other = w.players.find((p) => p !== victim && p !== attacker && p.villages.length >= 2);
  const lost = other.villages.splice(1, 1)[0];
  w.occupied.delete(`${lost.x},${lost.y}`);

  const founder = w.players.find((p) => p !== victim && p !== attacker && p !== other);
  w.addVillage(founder);
  const founded = founder.villages.at(-1);

  const { events, skipped } = diffVillages(before, mapOf(w));
  assert.equal(skipped, null);
  const by = (k) => events.filter((e) => e.kind === k);
  assert.equal(by('village_conquered').length, 1);
  assert.equal(by('village_abandoned').length, 1);
  assert.equal(by('village_founded').length, 1);

  const c = by('village_conquered')[0];
  assert.deepEqual([c.x, c.y, c.village_id], [conquered.x, conquered.y, conquered.vid]);
  assert.equal(c.player_id, attacker.id);
  assert.equal(c.player_name, attacker.name);
  assert.equal(c.from_player_id, victim.id);
  assert.equal(c.from_player_name, victim.name);
  assert.equal(by('village_abandoned')[0].player_id, other.id);
  assert.deepEqual([by('village_founded')[0].x, by('village_founded')[0].y], [founded.x, founded.y]);
  assert.equal(by('village_founded')[0].player_id, founder.id);
});

test('diffVillages refuses old-format maps and implausible amounts of change', () => {
  const w = createWorld({ seed: 6, players: 40, alliances: 3 });
  const before = mapOf(w);
  const oldFormat = { ...before, ver: 1 };
  delete oldFormat.pi;
  assert.match(diffVillages(oldFormat, before).skipped, /older format/);
  assert.deepEqual(diffVillages(oldFormat, before).events, []);

  advance(w);
  advance(w);
  const after = mapOf(w);
  assert.ok(diffVillages(before, after).events.length > 0);
  const capped = diffVillages(before, after, { maxEvents: 0 });
  assert.match(capped.skipped, /more than 0/);
  assert.deepEqual(capped.events, []);
});

test('every day records all players, breakdowns, concentration and a consistent change log', async () => {
  const { store, config } = await ingestDays(4);
  const snaps = await store.getRecentSnapshots(config.world, 10);
  assert.equal(snaps.length, 5);
  const ordered = [...snaps].reverse();

  // all players, ranked and tagged with their tribe, on every day
  for (const s of ordered) {
    const rows = store.playerHistory.filter((r) => r.snapshot_id === s.id);
    assert.equal(rows.length, s.players);
    assert.deepEqual(rows.map((r) => r.rank).sort((a, b) => a - b), rows.map((_, i) => i + 1));
    assert.ok(rows.every((r) => r.tribe > 0));
    assert.equal(store.allianceHistory.filter((r) => r.snapshot_id === s.id).length, s.alliances);
  }

  // breakdowns add up to the headline numbers
  for (const s of ordered) {
    const b = (kind) => store.breakdowns.filter((r) => r.snapshot_id === s.id && r.kind === kind);
    assert.equal(b('pop_bucket').reduce((n, r) => n + r.players, 0), s.players);
    assert.equal(b('village_bucket').reduce((n, r) => n + r.players, 0), s.players);
    assert.equal(b('quadrant').reduce((n, r) => n + r.villages, 0), s.villages);
    assert.equal(b('ring').reduce((n, r) => n + r.villages, 0), s.villages);
    assert.equal(b('region').reduce((n, r) => n + r.villages, 0), s.villages);
    assert.equal(b('quadrant').length, 4);
    assert.equal(s.top10_share, s.meta.concentration.top10);
    assert.equal(s.top100_share, s.meta.concentration.top100);
  }
  assert.deepEqual(await store.getBreakdowns([ordered[4].id], 'quadrant').then((r) => r.map((x) => x.key).sort()), ['NE', 'NW', 'SE', 'SW']);

  // the first snapshot has no baseline, so no events
  assert.equal(store.events.filter((e) => e.snapshot_id === ordered[0].id).length, 0);

  for (let i = 1; i < ordered.length; i++) {
    const s = ordered[i];
    const prev = ordered[i - 1];
    const ev = store.events.filter((e) => e.snapshot_id === s.id);
    const n = (k) => ev.filter((e) => e.kind === k).length;
    assert.equal(n('player_new'), s.new_players);
    assert.equal(n('player_departed'), s.departed_players);
    // every map village (players + Natars) is accounted for by a founded / abandoned event
    const villagesNow = s.villages + s.natar_villages;
    const villagesBefore = prev.villages + prev.natar_villages;
    assert.equal(villagesNow - villagesBefore, n('village_founded') - n('village_abandoned'));
  }
  const all = store.events;
  assert.ok(all.some((e) => e.kind === 'village_conquered'), 'the fixture produces conquests');
  assert.ok(all.some((e) => e.kind === 'village_founded'));
  assert.ok(all.some((e) => e.kind.startsWith('alliance_')), 'the fixture produces alliance moves');
});

test('getEvents filters by kind group, player, alliance and paginates', async () => {
  const { store, config } = await ingestDays(5);
  const total = store.events.length;
  const everything = await store.getEvents(config.world, { limit: 1000 });
  assert.equal(everything.total, total);
  assert.equal(everything.rows.length, total);
  assert.ok(everything.rows.every((r) => r.taken_at && r.world === undefined));
  // newest day first
  assert.ok(everything.rows.every((r, i, a) => i === 0 || a[i - 1].snapshot_id >= r.snapshot_id));

  const villages = await store.getEvents(config.world, { kinds: ['village_conquered'], limit: 1000 });
  assert.ok(villages.total > 0 && villages.rows.every((r) => r.kind === 'village_conquered'));

  const c = villages.rows[0];
  const forPlayer = await store.getEvents(config.world, { playerId: c.from_player_id, limit: 1000 });
  assert.ok(forPlayer.rows.some((r) => r.id === c.id), 'the former owner sees the conquest too');
  assert.ok(forPlayer.rows.every((r) => r.player_id === c.from_player_id || r.from_player_id === c.from_player_id));

  const page = await store.getEvents(config.world, { limit: 3, offset: 2 });
  assert.equal(page.rows.length, 3);
  assert.equal(page.total, total);
  assert.deepEqual(page.rows.map((r) => r.id), everything.rows.slice(2, 5).map((r) => r.id));

  const joined = store.events.find((e) => e.kind.startsWith('alliance_') && e.alliance_id);
  if (joined) {
    const forAlliance = await store.getEvents(config.world, { allianceId: joined.alliance_id, limit: 1000 });
    assert.ok(forAlliance.rows.every((r) => r.alliance_id === joined.alliance_id || r.from_alliance_id === joined.alliance_id));
  }
});

test('HISTORY_TOP_PLAYERS limits the per-day player history', async () => {
  const { store } = await ingestDays(2, { historyTopPlayers: 10 });
  for (const s of store.snapshots) assert.equal(store.playerHistory.filter((r) => r.snapshot_id === s.id).length, 10);
});

test('retention removes old snapshots with their rows and always keeps the newest', async () => {
  const { store, config, ingestor } = await ingestDays(3, { retentionDays: 5 });
  const old = new Date(Date.now() - 10 * 86400000).toISOString();
  store.snapshots[0].taken_at = old;
  store.snapshots[1].taken_at = old;
  const oldIds = new Set([store.snapshots[0].id, store.snapshots[1].id]);
  await ingestor.applyRetention();
  assert.equal(store.snapshots.length, 2);
  for (const list of [store.playerHistory, store.allianceHistory, store.breakdowns, store.events, store.tribeStats]) {
    assert.ok(list.every((r) => !oldIds.has(r.snapshot_id)));
  }
  assert.equal(await store.prune(config.world, 0), 0); // disabled

  // everything is older than the window, yet the newest snapshot survives
  for (const s of store.snapshots) s.taken_at = old;
  assert.equal(await store.prune(config.world, 1), 1);
  assert.equal(store.snapshots.length, 1);
});

test('API: events, breakdowns, player/alliance activity and storage status', async () => {
  const config = testConfig();
  const { store } = await ingestDays(3);
  const app = createApp({ config: { ...config, world: 'test.example.com' }, store, logger: silent });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() };
  };
  try {
    const all = (await get('/api/events?limit=100')).body;
    assert.equal(all.total, store.events.length);
    assert.ok(all.rows.length > 0 && all.rows.length <= 100);

    const v = (await get('/api/events?kind=village&limit=100')).body;
    assert.ok(v.total > 0 && v.rows.every((r) => r.kind.startsWith('village_')));
    const mixed = (await get('/api/events?kind=village_conquered,player&limit=100')).body;
    assert.ok(mixed.rows.every((r) => r.kind === 'village_conquered' || r.kind.startsWith('player_')));
    assert.equal((await get('/api/events?kind=explosions')).status, 400);

    const conquest = v.rows.find((r) => r.kind === 'village_conquered');
    const one = (await get(`/api/players/${conquest.player_id}`)).body;
    assert.ok(one.events.some((e) => e.id === conquest.id));
    assert.equal(one.history.length, 4);
    assert.ok(one.history.every((h) => h.rank >= 1));

    const rings = (await get('/api/breakdowns?kind=ring')).body;
    assert.equal(rings.snapshots.length, 4);
    assert.ok(rings.rows.length > 0 && rings.rows.every((r) => r.taken_at && r.key));
    assert.equal((await get('/api/breakdowns?kind=nope')).status, 400);
    // all snapshots were taken within milliseconds of each other; age two of them to exercise the `days` window
    const old = new Date(Date.now() - 10 * 86400000).toISOString();
    store.snapshots[0].taken_at = old;
    store.snapshots[1].taken_at = old;
    const recent = (await get('/api/breakdowns?kind=region&days=1')).body;
    assert.equal(recent.snapshots.length, 2);
    assert.ok(recent.rows.every((r) => r.taken_at !== old));

    const st = (await get('/api/status')).body;
    assert.equal(st.storage.db_bytes, null); // the in-memory store has no database size
    assert.equal(st.storage.tables.player_history.rows, store.playerHistory.length);
    assert.equal(st.storage.player_history, 'all players');

    const hist = (await get('/api/history')).body;
    assert.ok(hist.snapshots.every((s) => s.top10_share > 0 && s.top100_share >= s.top10_share));
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

// ---------------------------------------------------------------- Supabase store (REST wiring)
async function fake(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const rec = { method: req.method, path: url.pathname, params: [...url.searchParams], body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined };
      seen.push(rec);
      const out = handler(rec) || { body: [] };
      res.writeHead(200, { 'content-type': 'application/json', ...(out.headers || {}) });
      res.end(out.body === undefined ? '' : JSON.stringify(out.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('PostgREST client supports an `or` filter group', async () => {
  const f = await fake(() => ({ body: [] }));
  try {
    await new PostgrestClient(f.url, 'k').select('events', { filters: [['world', 'eq', 'w'], ['or', '', 'player_id.eq.5,from_player_id.eq.5']] });
    assert.deepEqual(Object.fromEntries(f.seen[0].params), { select: '*', world: 'eq.w', or: '(player_id.eq.5,from_player_id.eq.5)' });
  } finally {
    await f.close();
  }
});

test('SupabaseStore: events, breakdowns, storage stats and pruning talk to the right endpoints', async () => {
  const f = await fake((r) => {
    if (r.path.endsWith('/rpc/prune_history')) return { body: 7 };
    if (r.path.endsWith('/rpc/storage_stats')) return { body: { db_bytes: 123, tables: { events: { bytes: 1, rows: 2 } } } };
    if (r.path.endsWith('/events')) return { headers: { 'content-range': '0-0/41' }, body: [{ id: 9, snapshot_id: 3, kind: 'village_conquered', population: 90, snapshots: { taken_at: '2026-09-24T00:00:00Z' } }] };
    return { body: [] };
  });
  try {
    const store = new SupabaseStore({ url: f.url, key: 'k' });

    const ev = await store.getEvents('w', { kinds: ['village_founded', 'village_conquered'], playerId: 5, limit: 10, offset: 20 });
    assert.equal(ev.total, 41);
    assert.deepEqual(ev.rows, [{ id: 9, snapshot_id: 3, kind: 'village_conquered', population: 90, taken_at: '2026-09-24T00:00:00Z' }]);
    const p = Object.fromEntries(f.seen[0].params);
    assert.equal(p.world, 'eq.w');
    assert.equal(p.kind, 'in.(village_founded,village_conquered)');
    assert.equal(p.or, '(player_id.eq.5,from_player_id.eq.5)');
    assert.equal(p.order, 'snapshot_id.desc,population.desc.nullslast,id.asc');
    assert.equal(p.limit, '10');
    assert.equal(p.offset, '20');
    assert.match(p.select, /snapshots\(taken_at\)/);

    await store.getBreakdowns([1, 2], 'ring');
    const b = f.seen.at(-1);
    assert.equal(b.path, '/rest/v1/snapshot_breakdowns');
    assert.equal(Object.fromEntries(b.params).snapshot_id, 'in.(1,2)');
    assert.equal(Object.fromEntries(b.params).kind, 'eq.ring');
    assert.deepEqual(await store.getBreakdowns([], 'ring'), []);

    assert.equal((await store.getStorageStats()).db_bytes, 123);
    assert.equal(await store.prune('w', 90), 7);
    assert.deepEqual(f.seen.at(-1).body, { p_world: 'w', p_keep_days: 90 });

    await store.getPlayerHistory(5, 10);
    assert.match(Object.fromEntries(f.seen.at(-1).params).select, /rank,tribe/);
  } finally {
    await f.close();
  }
});
