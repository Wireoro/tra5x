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

/**
 * Fills in the distance fields of `rows` (see geo.js for the definitions) from the village map kept by the
 * ingestion. Never fails the comparison: without a usable map the distances simply stay null.
 */
async function addDistances(rows, mine, getMap, geoOptions) {
  const none = { geometry: null, location: null };
  if (!getMap || !mine) return none;
  try {
    const map = await getMap();
    if (!map || !Array.isArray(map.pi) || !Array.isArray(map.u)) return none;
    const g = geo.worldGeometry(map.bounds, geoOptions);
    const villages = geo.villagesByPlayer(map, rows.map((r) => r.id));
    const mineVillages = villages.get(mine.id) || [];
    const myCentre = geo.centre(g, mineVillages);

    for (const r of rows) {
      const theirs = villages.get(r.id) || [];
      const c = geo.centre(g, theirs);
      r.centre = c ? { x: c.x, y: c.y } : null;
      r.spread = c ? c.spread : null;
      if (r.is_me) continue;
      const closest = geo.closestApproach(g, mineVillages, theirs);
      if (closest) {
        r.distance = geo.round1(closest.distance);
        r.closest = { you: closest.from, them: closest.to };
      }
      if (myCentre && c) r.centre_distance = geo.round1(geo.distance(g, myCentre.x, myCentre.y, c.x, c.y));
    }
    return {
      geometry: { radius: g.radius, size: g.size, wrap: g.wrap, source: g.source },
      location: { villages: mineVillages.length, centre: myCentre ? { x: myCentre.x, y: myCentre.y } : null, spread: myCentre ? myCentre.spread : null, main: geo.mainVillage(mineVillages) },
    };
  } catch {
    return none;
  }
}

/**
 * Players ranked around `name` and how much each of them grew over the last `days` days compared with that
 * player. Growth is measured between two stored daily snapshots (player_history), so it needs at least two.
 */
async function buildCompare(store, world, { name, above = 10, below = 10, days = 7, getMap = null, geoOptions = {} }) {
  const me = await resolvePlayer(store, world, name);
  const series = await store.getSnapshotSeries(world, 400);
  if (!series.length) throw new CompareError(503, 'No snapshot has been stored yet.');
  const latest = series[series.length - 1];
  const ref = series.length >= 2 ? pickReference(series, days) : null;

  const myRank = me.rank || 1;
  const offset = Math.max(0, myRank - 1 - above);
  const limit = myRank - 1 - offset + 1 + below;
  const { rows: near } = await store.listPlayers(world, { sort: 'rank', dir: 'asc', offset, limit });

  const then = new Map();
  if (ref) for (const r of await store.getPlayersAtSnapshot(ref.id, near.map((p) => p.id))) then.set(r.player_id, r);

  const rows = near.map((p) => {
    const t = then.get(p.id);
    const gain = t ? p.population - t.population : null;
    return {
      id: p.id,
      name: p.name,
      tribe: p.tribe,
      tribe_name: tribeName(p.tribe),
      alliance_id: p.alliance_id,
      alliance_tag: p.alliance_tag,
      rank: p.rank,
      population: p.population,
      villages: p.villages,
      is_me: p.id === me.id,
      population_then: t ? t.population : null,
      gain,
      gain_pct: t && t.population > 0 ? gain / t.population : null,
      villages_then: t ? t.villages : null,
      village_gain: t ? p.villages - t.villages : null,
      rank_then: t && t.rank != null ? t.rank : null,
      rank_change: t && t.rank != null ? t.rank - p.rank : null, // positive = moved up
      vs_me_pop: null,
      vs_me_pct: null,
      distance: null, // closest approach to the player, in fields
      closest: null, // {you:{x,y}, them:{x,y}}: the two villages that produce it
      centre_distance: null, // distance between the two population-weighted centres, in fields
      centre: null, // {x,y}
      spread: null, // population-weighted average distance of the player's villages from their own centre
    };
  });

  const mine = rows.find((r) => r.is_me);
  for (const r of rows) {
    if (r.is_me || !mine) continue;
    if (r.gain != null && mine.gain != null) r.vs_me_pop = r.gain - mine.gain;
    if (r.gain_pct != null && mine.gain_pct != null) r.vs_me_pct = r.gain_pct - mine.gain_pct;
  }

  const others = rows.filter((r) => !r.is_me && r.gain_pct != null);
  const myPct = mine ? mine.gain_pct : null;
  const summary = {
    compared: others.length,
    faster: myPct == null ? null : others.filter((r) => r.gain_pct > myPct).length,
    slower: myPct == null ? null : others.filter((r) => r.gain_pct < myPct).length,
    same: myPct == null ? null : others.filter((r) => r.gain_pct === myPct).length,
    median_gain: median(others.map((r) => r.gain)),
    median_gain_pct: median(others.map((r) => r.gain_pct)),
    my_growth_position: myPct == null ? null : 1 + others.filter((r) => r.gain_pct > myPct).length, // 1 = fastest
  };

  const where = await addDistances(rows, mine, getMap, geoOptions);

  // Chart: the player plus the nearest ranks, one point per stored snapshot since the reference day.
  const startId = ref ? ref.id : latest.id;
  const chosen = [mine, ...rows.filter((r) => !r.is_me).sort((a, b) => Math.abs(a.rank - myRank) - Math.abs(b.rank - myRank) || a.rank - b.rank).slice(0, CHART_NEIGHBOURS)];
  const chosenRows = chosen.filter(Boolean);
  const hist = await store.getPlayersHistory(chosenRows.map((r) => r.id), startId);
  const snaps = series.filter((s) => s.id >= startId);
  const popAt = new Map(hist.map((h) => [`${h.player_id}:${h.snapshot_id}`, h.population]));

  const actualDays = ref ? (Date.parse(latest.taken_at) - Date.parse(ref.taken_at)) / DAY : null;
  return {
    world,
    me: mine,
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
    geometry: where.geometry,
    location: where.location,
    above: mine ? mine.rank - rows[0].rank : 0,
    below: mine ? rows[rows.length - 1].rank - mine.rank : 0,
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

module.exports = { buildCompare, CompareError, pickReference, resolvePlayer };
