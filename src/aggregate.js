'use strict';

const { NATAR_TRIBE } = require('./travian');

const POP_EDGES = [0, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, Infinity];
const VILLAGE_EDGES = [1, 2, 3, 4, 6, 8, 11, 16, 26, Infinity];

/** Counts values into [edge[i], edge[i+1]) buckets. `max` is inclusive (null = open-ended). */
function bucketize(values, edges) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    out.push({ min: edges[i], max: Number.isFinite(edges[i + 1]) ? edges[i + 1] - 1 : null, count: 0 });
  }
  for (const v of values) {
    for (let i = 0; i < out.length; i++) {
      if (v < edges[i + 1]) {
        out[i].count++;
        break;
      }
    }
  }
  return out;
}

function niceRingWidth(maxDist) {
  const target = Math.max(1, maxDist / 10);
  for (const w of [5, 10, 20, 25, 50, 100, 200]) if (w >= target) return w;
  return 200;
}

/**
 * Turns parsed map.sql rows into (a) the aggregated payload consumed by the `ingest_snapshot`
 * SQL function / memory store and (b) a compact village list (kept for village-change events, for distances
 * between players, and for reading the current alliance breakdown of a region straight off the map).
 *
 * Rules: a row is an occupied village when it has a player id > 0. Natars (tribe 5) are counted
 * separately and excluded from player / alliance rankings and totals.
 */
function aggregate(rows) {
  // `rows` can be any iterable (array or generator).
  const players = new Map();
  const natarPlayers = new Set();
  const alliances = new Map();
  const regions = new Map();

  // ver 2 adds ids so consecutive maps can be diffed: v = village id per village, pi / ai = player / alliance
  // id for each entry of pn / at (the arrays u and a index into them). ver 3 adds rg / rn the same way for the
  // "region" field of map.sql, so the current alliance breakdown of a region can be read straight from the map.
  const map = { ver: 3, x: [], y: [], t: [], p: [], u: [], a: [], f: [], n: [], v: [], rg: [], pn: [], pi: [], at: [], ai: [], rn: [] };
  const playerIdx = new Map();
  const allianceIdx = new Map();
  const regionIdx = new Map();

  const totals = {
    tiles: 0,
    players: 0,
    alliances: 0,
    villages: 0,
    natar_villages: 0,
    population: 0,
    capitals: 0,
    cities: 0,
    harbors: 0,
    players_in_alliance: 0,
  };
  const tribeVillages = new Map(); // tribe -> {villages, population}
  const quad = { NE: { villages: 0, population: 0 }, NW: { villages: 0, population: 0 }, SW: { villages: 0, population: 0 }, SE: { villages: 0, population: 0 } };
  const dist = []; // [distance, population] of player villages
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let maxDist = 0;

  for (const r of rows) {
    totals.tiles++;
    if (r.x < minX) minX = r.x;
    if (r.x > maxX) maxX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.y > maxY) maxY = r.y;

    if (!(r.playerId > 0)) continue; // unoccupied tile / oasis
    const natar = r.tribe === NATAR_TRIBE;

    // --- compact map arrays (all occupied villages, Natars included) ---
    let ui = playerIdx.get(r.playerId);
    if (ui === undefined) {
      ui = map.pn.length;
      playerIdx.set(r.playerId, ui);
      map.pn.push(r.player || `#${r.playerId}`);
      map.pi.push(r.playerId);
    }
    let ai = -1;
    if (r.allianceId > 0) {
      ai = allianceIdx.get(r.allianceId);
      if (ai === undefined) {
        ai = map.at.length;
        allianceIdx.set(r.allianceId, ai);
        map.at.push(r.alliance || `#${r.allianceId}`);
        map.ai.push(r.allianceId);
      }
    }
    let ri = -1;
    if (r.region != null && r.region !== '') {
      const key = String(r.region).slice(0, 80); // matches the cap used for the region breakdown key
      ri = regionIdx.get(key);
      if (ri === undefined) {
        ri = map.rn.length;
        regionIdx.set(key, ri);
        map.rn.push(key);
      }
    }
    map.x.push(r.x);
    map.y.push(r.y);
    map.t.push(r.tribe ?? 0);
    map.p.push(r.population);
    map.u.push(ui);
    map.a.push(ai);
    map.f.push((r.capital ? 1 : 0) | (r.city ? 2 : 0) | (r.harbor ? 4 : 0));
    map.n.push(r.village || '');
    map.v.push(r.villageId ?? 0);
    map.rg.push(ri);

    const tv = tribeVillages.get(r.tribe) || { villages: 0, population: 0 };
    tv.villages++;
    tv.population += r.population;
    tribeVillages.set(r.tribe, tv);

    if (natar) {
      totals.natar_villages++;
      natarPlayers.add(r.playerId);
      continue;
    }

    // --- player level ---
    let p = players.get(r.playerId);
    if (!p) {
      p = {
        id: r.playerId,
        name: r.player || `#${r.playerId}`,
        tribe: r.tribe,
        alliance_id: r.allianceId > 0 ? r.allianceId : null,
        alliance_tag: r.allianceId > 0 ? r.alliance || null : null,
        villages: 0,
        population: 0,
        capital_x: null,
        capital_y: null,
        victory_points: null,
      };
      players.set(r.playerId, p);
    }
    p.villages++;
    p.population += r.population;
    if (r.capital) {
      p.capital_x = r.x;
      p.capital_y = r.y;
      totals.capitals++;
    }
    if (r.city) totals.cities++;
    if (r.harbor) totals.harbors++;

    totals.villages++;
    totals.population += r.population;

    const q = r.x >= 0 ? (r.y >= 0 ? quad.NE : quad.SE) : r.y >= 0 ? quad.NW : quad.SW;
    q.villages++;
    q.population += r.population;

    const d = Math.hypot(r.x, r.y);
    if (d > maxDist) maxDist = d;
    dist.push(d, r.population);

    if (r.region != null && r.region !== '') {
      const g = regions.get(r.region) || { region: r.region, villages: 0, population: 0 };
      g.villages++;
      g.population += r.population;
      regions.set(r.region, g);
    }
  }

  // --- alliances ---
  for (const p of players.values()) {
    if (p.alliance_id == null) continue;
    let a = alliances.get(p.alliance_id);
    if (!a) {
      a = { id: p.alliance_id, tag: p.alliance_tag || `#${p.alliance_id}`, members: 0, villages: 0, population: 0 };
      alliances.set(p.alliance_id, a);
    }
    a.members++;
    a.villages += p.villages;
    a.population += p.population;
    totals.players_in_alliance++;
  }
  totals.players = players.size;
  totals.alliances = alliances.size;

  // --- tribes ---
  const tribePlayers = new Map();
  for (const p of players.values()) tribePlayers.set(p.tribe, (tribePlayers.get(p.tribe) || 0) + 1);
  const tribes = [];
  for (const [tribe, tv] of tribeVillages) {
    if (tribe == null) continue;
    tribes.push({
      tribe,
      players: tribe === NATAR_TRIBE ? natarPlayers.size : tribePlayers.get(tribe) || 0,
      villages: tv.villages,
      population: tv.population,
    });
  }
  tribes.sort((a, b) => a.tribe - b.tribe);

  // --- distributions & concentration ---
  const playerList = [...players.values()];
  const pops = playerList.map((p) => p.population).sort((a, b) => b - a);
  const share = (n) => {
    if (!totals.population) return 0;
    let s = 0;
    for (let i = 0; i < Math.min(n, pops.length); i++) s += pops[i];
    return s / totals.population;
  };

  const ringWidth = niceRingWidth(maxDist);
  const ringCount = Math.max(1, Math.ceil((maxDist + 1e-9) / ringWidth));
  const ringItems = Array.from({ length: ringCount }, (_, i) => ({ from: i * ringWidth, to: (i + 1) * ringWidth, villages: 0, population: 0 }));
  for (let i = 0; i < dist.length; i += 2) {
    const idx = Math.min(ringCount - 1, Math.floor(dist[i] / ringWidth));
    ringItems[idx].villages++;
    ringItems[idx].population += dist[i + 1];
  }

  const meta = {
    bounds: Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null,
    pop_buckets: bucketize(pops, POP_EDGES),
    village_buckets: bucketize(playerList.map((p) => p.villages), VILLAGE_EDGES),
    quadrants: quad,
    rings: { width: ringWidth, items: ringItems },
    regions: [...regions.values()].sort((a, b) => b.villages - a.villages).slice(0, 20),
    concentration: { top10: share(10), top100: share(100) },
  };

  map.bounds = meta.bounds;
  map.count = map.x.length;

  return {
    payload: {
      totals,
      tribes,
      alliances: [...alliances.values()],
      players: playerList,
      meta,
      breakdowns: buildBreakdowns(meta, regions),
    },
    map,
  };
}

const bucketKey = (b) => (b.max == null ? `${b.min}+` : `${b.min}-${b.max}`);

/**
 * Flat, queryable rows for the `snapshot_breakdowns` table (one per kind + bucket):
 * pop_bucket / village_bucket (`players` = players in the bucket), quadrant, ring and region
 * (`villages` / `population` of player villages).
 */
function buildBreakdowns(meta, regions) {
  const out = [];
  for (const b of meta.pop_buckets) out.push({ kind: 'pop_bucket', key: bucketKey(b), lo: b.min, hi: b.max, players: b.count, villages: 0, population: 0 });
  for (const b of meta.village_buckets) out.push({ kind: 'village_bucket', key: bucketKey(b), lo: b.min, hi: b.max, players: b.count, villages: 0, population: 0 });
  for (const [key, q] of Object.entries(meta.quadrants)) out.push({ kind: 'quadrant', key, lo: null, hi: null, players: 0, villages: q.villages, population: q.population });
  for (const r of meta.rings.items) out.push({ kind: 'ring', key: `${r.from}-${r.to}`, lo: r.from, hi: r.to, players: 0, villages: r.villages, population: r.population });
  const seen = new Set();
  for (const g of [...regions.values()].sort((a, b) => b.villages - a.villages).slice(0, 500)) {
    const key = String(g.region).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: 'region', key, lo: null, hi: null, players: 0, villages: g.villages, population: g.population });
  }
  return out;
}

module.exports = { aggregate, bucketize, POP_EDGES, VILLAGE_EDGES };
