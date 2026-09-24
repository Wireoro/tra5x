'use strict';

const { tribeName } = require('./views');
const geo = require('./geo');

const DAY = 86400000;
const CHART_NEIGHBOURS = 6; // the chart shows the player plus the nearest N ranks

/** An error the API turns into an HTTP response with a JSON body. */
class CompareError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Exact name (case-insensitive) or numeric player id; otherwise a 404 that carries "did you mean" suggestions. */
async function resolvePlayer(store, world, input) {
  const name = String(input).trim();
  if (/^\d{1,12}$/.test(name)) {
    const byId = await store.getPlayer(world, Number(name));
    if (byId) return byId;
  }
  const exact = await store.listPlayers(world, { exactName: name, limit: 5 });
  const hit = exact.rows.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit;

  const near = await store.listPlayers(world, { q: name, sort: 'rank', limit: 8 });
  throw new CompareError(404, `No player named "${name}" on this world.`, {
    suggestions: near.rows.map((r) => ({ id: r.id, name: r.name, rank: r.rank, tribe: r.tribe, alliance_tag: r.alliance_tag })),
  });
}

/**
 * The snapshot to measure growth from: the stored snapshot closest to "latest minus `days`" (daily snapshots
 * are not taken at exactly 24 h intervals, so nearest beats "at least that old"). days = 0 means the oldest one.
 */
function pickReference(series, days) {
  const latest = series[series.length - 1];
  const older = series.slice(0, -1);
  if (!older.length) return null;
  if (!days) return older[0];
  const target = Date.parse(latest.taken_at) - days * DAY;
  let best = older[0];
  let bestDist = Math.abs(Date.parse(best.taken_at) - target);
  for (const s of older) {
    const d = Math.abs(Date.parse(s.taken_at) - target);
    if (d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

const DEFAULT_RADIUS = 50; // fields
const MAX_RADIUS = 200;
const MAX_NEARBY = 300; // rows returned; when more players are in range the nearest ones are kept

/** Loads and checks the village map; the comparison is built on it, so a missing map is an error, not a gap. */
async function loadVillageMap(getMap) {
  let map = null;
  try {
    map = getMap ? await getMap() : null;
  } catch {
    map = null;
  }
  if (!map || !Array.isArray(map.pi) || !Array.isArray(map.u) || !Array.isArray(map.t)) {
    throw new CompareError(503, 'The village map is not available yet, so nearby players cannot be found. It is created with the next daily snapshot.');
  }
  return map;
}

/**
 * The players who have a village within `radius` fields of one of the player's villages, ranked among themselves
 * (rank 1 = the most population), and how much each of them grew over the last `days` days compared with that
 * player. Growth is measured between two stored daily snapshots (player_history), so it needs at least two.
 * Distances follow geo.js: a player is "nearby" exactly when their closest approach is within the radius.
 */
async function buildCompare(store, world, { name, radius = DEFAULT_RADIUS, origin = 'main', days = 7, getMap = null, geoOptions = {}, maxNearby = MAX_NEARBY }) {
  radius = Math.min(MAX_RADIUS, Math.max(1, Number(radius) || DEFAULT_RADIUS));
  const meRow = await resolvePlayer(store, world, name);
  const series = await store.getSnapshotSeries(world, 400);
  if (!series.length) throw new CompareError(503, 'No snapshot has been stored yet.');
  const latest = series[series.length - 1];
  const ref = series.length >= 2 ? pickReference(series, days) : null;

  // --- who is nearby
  const map = await loadVillageMap(getMap);
  const g = geo.worldGeometry(map.bounds, geoOptions);
  const mineVillages = geo.villagesByPlayer(map, [meRow.id]).get(meRow.id) || [];
  // origin 'main' (default): one circle around your capital, or your biggest village if none is flagged - a player with
  // villages all over the map would otherwise have hundreds of "neighbours". 'all': measured from every village of yours.
  const main = geo.mainVillage(mineVillages);
  const useMain = origin !== 'all' && main;
  const found = geo.nearbyPlayers(g, map, useMain ? [{ x: main.x, y: main.y }] : mineVillages, radius, { exclude: meRow.id });
  const candidates = [...found.entries()].sort((a, b) => a[1].distance - b[1].distance || a[0] - b[0]);
  const kept = candidates.slice(0, maxNearby);
  const players = await store.getPlayersByIds(world, [meRow.id, ...kept.map(([id]) => id)]);
  const byId = new Map(players.map((p) => [p.id, p]));
  const nearby = { total: candidates.length, shown: 0, truncated: candidates.length > maxNearby };

  // --- growth since the reference snapshot
  const ids = players.map((p) => p.id);
  const then = new Map();
  if (ref) for (const r of await store.getPlayersAtSnapshot(ref.id, ids)) then.set(r.player_id, r);

  const centres = geo.villagesByPlayer(map, ids);
  const myCentre = geo.centre(g, mineVillages);

  const rows = [];
  for (const p of [meRow, ...kept.map(([id]) => byId.get(id))]) {
    if (!p) continue; // in the map but not in the players table (the two are stored together, so this is not expected)
    const t = then.get(p.id);
    const gain = t ? p.population - t.population : null;
    const isMe = p.id === meRow.id;
    const f = found.get(p.id);
    const c = geo.centre(g, centres.get(p.id) || []);
    rows.push({
      id: p.id,
      name: p.name,
      tribe: p.tribe,
      tribe_name: tribeName(p.tribe),
      alliance_id: p.alliance_id,
      alliance_tag: p.alliance_tag,
      rank: null, // rank among the players listed here, by population (1 = most); filled in below
      world_rank: p.rank,
      population: p.population,
      villages: p.villages,
      is_me: isMe,
      population_then: t ? t.population : null,
      gain,
      gain_pct: t && t.population > 0 ? gain / t.population : null,
      villages_then: t ? t.villages : null,
      village_gain: t ? p.villages - t.villages : null,
      rank_change: null, // places gained (+) or lost (-) among the listed players over the period
      vs_me_pop: null,
      vs_me_pct: null,
      distance: f ? geo.round1(f.distance) : null, // closest approach to you, in fields
      closest: f ? { you: f.from, them: f.to } : null, // the two villages that produce it
      villages_in_range: f ? f.inRange : null, // their villages within the radius of one of yours
      centre_distance: !isMe && c && myCentre ? geo.round1(geo.distance(g, myCentre.x, myCentre.y, c.x, c.y)) : null,
      centre: c ? { x: c.x, y: c.y } : null,
      spread: c ? c.spread : null, // population-weighted average distance of the player's villages from their own centre
    });
  }
  nearby.shown = rows.length - 1;

  // Rank among the listed players: population, biggest first (ties: the better world rank first).
  const byPop = (a, b) => b.population - a.population || (a.world_rank ?? 1e9) - (b.world_rank ?? 1e9) || a.id - b.id;
  [...rows].sort(byPop).forEach((r, i) => { r.rank = i + 1; });

  // Rank change: compare the ranking then and now for the players that existed at both times.
  if (ref) {
    const both = rows.filter((r) => r.population_then !== null);
    const nowOrder = new Map([...both].sort(byPop).map((r, i) => [r.id, i + 1]));
    const thenOrder = new Map([...both].sort((a, b) => b.population_then - a.population_then || byPop(a, b)).map((r, i) => [r.id, i + 1]));
    for (const r of both) r.rank_change = thenOrder.get(r.id) - nowOrder.get(r.id);
  }

  const mine = rows.find((r) => r.is_me);
  for (const r of rows) {
    if (r.is_me) continue;
    if (r.gain != null && mine.gain != null) r.vs_me_pop = r.gain - mine.gain;
    if (r.gain_pct != null && mine.gain_pct != null) r.vs_me_pct = r.gain_pct - mine.gain_pct;
  }

  const others = rows.filter((r) => !r.is_me && r.gain_pct != null);
  const myPct = mine.gain_pct;
  const summary = {
    compared: others.length,
    faster: myPct == null ? null : others.filter((r) => r.gain_pct > myPct).length,
    slower: myPct == null ? null : others.filter((r) => r.gain_pct < myPct).length,
    same: myPct == null ? null : others.filter((r) => r.gain_pct === myPct).length,
    median_gain: median(others.map((r) => r.gain)),
    median_gain_pct: median(others.map((r) => r.gain_pct)),
    my_growth_position: myPct == null ? null : 1 + others.filter((r) => r.gain_pct > myPct).length, // 1 = fastest
  };

  // Chart: the player plus the nearby players closest to them in size, one point per stored snapshot since the reference day.
  const startId = ref ? ref.id : latest.id;
  const chosenRows = [mine, ...rows.filter((r) => !r.is_me).sort((a, b) => Math.abs(a.rank - mine.rank) - Math.abs(b.rank - mine.rank) || a.rank - b.rank).slice(0, CHART_NEIGHBOURS)];
  const hist = await store.getPlayersHistory(chosenRows.map((r) => r.id), startId);
  const snaps = series.filter((s) => s.id >= startId);
  const popAt = new Map(hist.map((h) => [`${h.player_id}:${h.snapshot_id}`, h.population]));

  const actualDays = ref ? (Date.parse(latest.taken_at) - Date.parse(ref.taken_at)) / DAY : null;
  return {
    world,
    me: mine,
    radius,
    origin: useMain ? 'main' : 'all',
    nearby,
    period: ref
      ? {
          requested_days: days || null,
          actual_days: Math.round(actualDays * 100) / 100,
          from: ref.taken_at,
          to: latest.taken_at,
          truncated: days > 0 && actualDays < days * 0.8,
        }
      : null,
    snapshots_stored: series.length,
    geometry: { radius: g.radius, size: g.size, wrap: g.wrap, source: g.source },
    location: { villages: mineVillages.length, centre: myCentre ? { x: myCentre.x, y: myCentre.y } : null, spread: myCentre ? myCentre.spread : null, main },
    rows,
    summary,
    series: {
      times: snaps.map((s) => s.taken_at),
      players: chosenRows.map((r) => ({
        id: r.id,
        name: r.name,
        is_me: r.is_me,
        points: snaps.map((s) => popAt.get(`${r.id}:${s.id}`) ?? null),
      })),
    },
  };
}

module.exports = { buildCompare, CompareError, pickReference, resolvePlayer, DEFAULT_RADIUS, MAX_RADIUS, MAX_NEARBY };
