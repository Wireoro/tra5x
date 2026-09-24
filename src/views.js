'use strict';

const { TRIBES, NATAR_TRIBE } = require('./travian');

const tribeName = (id) => TRIBES[id] || `Tribe ${id}`;
const ratio = (a, b) => (b ? a / b : null);

function snapshotSummary(s) {
  if (!s) return null;
  const { meta, ...rest } = s;
  return rest;
}

/** Everything the Overview tab needs, in one response. */
async function buildOverview(store, world) {
  const [latest, previous] = await store.getRecentSnapshots(world, 2);
  if (!latest) return null;

  const ids = [latest.id, previous?.id].filter((x) => x != null);
  const [tribeRows, topPlayers, topAlliances, gainers, losers] = await Promise.all([
    store.getTribeStats(ids),
    store.listPlayers(world, { limit: 10 }),
    store.listAlliances(world, { limit: 10 }),
    store.getMovers(world, 'gain', 10),
    store.getMovers(world, 'loss', 10),
  ]);

  const delta = (key) => (previous ? Number(latest[key]) - Number(previous[key]) : null);
  const totals = {
    players: latest.players,
    alliances: latest.alliances,
    villages: latest.villages,
    natar_villages: latest.natar_villages,
    population: Number(latest.population),
    capitals: latest.capitals,
    cities: latest.cities,
    harbors: latest.harbors,
    players_in_alliance: latest.players_in_alliance,
    tiles: latest.tiles,
  };

  const prevTribe = new Map(tribeRows.filter((r) => r.snapshot_id === previous?.id).map((r) => [r.tribe, r]));
  const currentTribes = tribeRows.filter((r) => r.snapshot_id === latest.id);
  const playerTotal = currentTribes.filter((r) => r.tribe !== NATAR_TRIBE).reduce((s, r) => s + r.players, 0);
  const tribes = currentTribes.map((r) => {
    const natar = r.tribe === NATAR_TRIBE;
    const prev = prevTribe.get(r.tribe);
    return {
      tribe: r.tribe,
      name: tribeName(r.tribe),
      players: r.players,
      villages: r.villages,
      population: Number(r.population),
      player_share: natar ? null : ratio(r.players, playerTotal),
      village_share: natar ? null : ratio(r.villages, totals.villages),
      population_share: natar ? null : ratio(Number(r.population), totals.population),
      population_delta: prev ? Number(r.population) - Number(prev.population) : null,
    };
  });

  const meta = latest.meta || {};
  return {
    world,
    snapshot: snapshotSummary(latest),
    previous: snapshotSummary(previous),
    totals,
    deltas: {
      players: delta('players'),
      alliances: delta('alliances'),
      villages: delta('villages'),
      population: delta('population'),
      natar_villages: delta('natar_villages'),
      new_players: latest.new_players,
      departed_players: latest.departed_players,
    },
    derived: {
      avg_villages_per_player: ratio(totals.villages, totals.players),
      avg_pop_per_village: ratio(totals.population, totals.villages),
      avg_pop_per_player: ratio(totals.population, totals.players),
      alliance_membership: ratio(totals.players_in_alliance, totals.players),
      avg_alliance_size: ratio(totals.players_in_alliance, totals.alliances),
      top10_share: meta.concentration?.top10 ?? null,
      top100_share: meta.concentration?.top100 ?? null,
    },
    tribes,
    distributions: {
      pop_buckets: meta.pop_buckets || [],
      village_buckets: meta.village_buckets || [],
      quadrants: meta.quadrants || null,
      rings: meta.rings || null,
      regions: meta.regions || [],
      bounds: meta.bounds || null,
    },
    top_players: topPlayers.rows,
    top_alliances: topAlliances.rows,
    gainers,
    losers,
  };
}

/** Snapshots of the last `days` days (0 = everything stored), oldest first. */
async function seriesWindow(store, world, days) {
  let series = await store.getSnapshotSeries(world, 400);
  if (days > 0 && series.length) {
    const cutoff = Date.parse(series[series.length - 1].taken_at) - days * 86400000;
    series = series.filter((s) => Date.parse(s.taken_at) >= cutoff);
  }
  return series;
}

/** Per-day rows of one breakdown kind (region, ring, quadrant, pop_bucket, village_bucket). */
async function buildBreakdowns(store, world, { kind, days = 0 }) {
  const series = await seriesWindow(store, world, days);
  const takenAt = new Map(series.map((s) => [s.id, s.taken_at]));
  const rows = await store.getBreakdowns(series.map((s) => s.id), kind);
  return {
    world,
    kind,
    snapshots: series.map((s) => ({ id: s.id, taken_at: s.taken_at })),
    rows: rows.map((r) => ({ taken_at: takenAt.get(r.snapshot_id), key: r.key, lo: r.lo == null ? null : Number(r.lo), hi: r.hi == null ? null : Number(r.hi), players: r.players, villages: r.villages, population: Number(r.population) })),
  };
}

/** Time series for the Trends tab. `days` = 0 means everything stored. */
async function buildHistory(store, world, { days = 0, allianceCount = 5 } = {}) {
  const series = await seriesWindow(store, world, days);
  const ids = series.map((s) => s.id);
  const takenAt = new Map(series.map((s) => [s.id, s.taken_at]));

  const [tribeRows, top] = await Promise.all([store.getTribeStats(ids), store.listAlliances(world, { limit: allianceCount })]);
  const tribeMap = new Map();
  for (const r of tribeRows) {
    if (!tribeMap.has(r.tribe)) tribeMap.set(r.tribe, { tribe: r.tribe, name: tribeName(r.tribe), points: [] });
    tribeMap.get(r.tribe).points.push({ taken_at: takenAt.get(r.snapshot_id), players: r.players, villages: r.villages, population: Number(r.population) });
  }

  const allianceRows = await store.getAllianceHistory(top.rows.map((a) => a.id), ids);
  const alliances = top.rows.map((a) => ({
    id: a.id,
    tag: a.tag,
    points: allianceRows
      .filter((r) => r.alliance_id === a.id)
      .map((r) => ({ taken_at: r.taken_at, population: Number(r.population), members: r.members, villages: r.villages })),
  }));

  return {
    world,
    snapshots: series.map((s) => ({ ...s, population: Number(s.population) })),
    tribes: [...tribeMap.values()].sort((a, b) => a.tribe - b.tribe),
    alliances,
  };
}

module.exports = { buildOverview, buildHistory, buildBreakdowns, tribeName };
