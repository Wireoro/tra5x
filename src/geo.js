'use strict';

/**
 * Geometry of a Travian world, used to say how far apart players are.
 *
 * Facts this relies on (Travian support, "Guide: The Map"): distance is the straight line between the
 * two tiles' coordinates, measured in tiles ("fields"), and the map wraps around like a globe, so a village
 * at x = 200 is right next to one at x = -200. The wrap can be switched off for special worlds with hard edges.
 *
 * A player is not a point: villages are scattered. Two summary numbers are offered, and each one is
 * exactly defined so it can be checked by hand:
 *
 *   closest approach  the shortest distance between ANY village of A and ANY village of B. Troops, resources and
 *                     reinforcements travel village to village, so this is the distance at which the two players
 *                     can actually reach each other.
 *   centre distance   distance between the two players' centres of gravity (village positions weighted by
 *                     population). It says where the players "live" overall. Because villages are scattered, the
 *                     centre can lie between clusters, so each player also gets a "spread": the population-weighted
 *                     average distance of their villages from their own centre. A large spread means: read the
 *                     centre with care.
 *
 * Centres are computed on the wrapped map as a circular mean (each coordinate becomes an angle on a circle,
 * the weighted angles are averaged, and the result is converted back). A plain average would put the centre of
 * villages at x = 199 and x = -199 in the middle of the map instead of at the seam.
 */

/**
 * @param {{minX:number,maxX:number,minY:number,maxY:number}|null} bounds extent of all tiles in map.sql
 * @param {{radius?:number, wrap?:boolean}} opts `radius` overrides the size inferred from the file
 * @returns {{radius:number|null, size:number|null, wrap:boolean, source:'configured'|'inferred'|'unknown'}}
 *   size = number of fields along one axis (radius 200 -> 401), which is the period of the wrap-around.
 */
function worldGeometry(bounds, { radius = 0, wrap = true } = {}) {
  let r = Number(radius) > 0 ? Math.floor(Number(radius)) : 0;
  let source = r ? 'configured' : 'inferred';
  if (!r && bounds) r = Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX), Math.abs(bounds.minY), Math.abs(bounds.maxY));
  if (!r) return { radius: null, size: null, wrap: false, source: 'unknown' };
  return { radius: r, size: 2 * r + 1, wrap: wrap !== false, source };
}

/** Shortest separation along one axis (going around the seam when that is shorter). */
function axisDelta(g, a, b) {
  const d = Math.abs(a - b);
  return g.wrap && g.size ? Math.min(d, g.size - d) : d;
}

/** Straight-line distance in fields between two points, taking the wrap-around into account. */
function distance(g, x1, y1, x2, y2) {
  return Math.hypot(axisDelta(g, x1, x2), axisDelta(g, y1, y2));
}

/**
 * Village lists for the given player ids, read from the compact map (ver >= 2) kept by the ingestion.
 * @returns {Map<number, Array<{x:number,y:number,pop:number,capital:boolean,name:string}>>}
 */
function villagesByPlayer(map, playerIds) {
  const out = new Map(playerIds.map((id) => [id, []]));
  const wanted = new Set(playerIds);
  const idxToId = new Map();
  for (let i = 0; i < map.pi.length; i++) if (wanted.has(map.pi[i])) idxToId.set(i, map.pi[i]);
  if (!idxToId.size) return out;
  for (let v = 0; v < map.u.length; v++) {
    const id = idxToId.get(map.u[v]);
    if (id !== undefined) out.get(id).push({ x: map.x[v], y: map.y[v], pop: map.p[v], capital: (map.f[v] & 1) === 1, name: map.n[v] });
  }
  return out;
}

/** Shortest distance between any village of `a` and any village of `b`, with the pair that produces it. */
function closestApproach(g, a, b) {
  let best = null;
  for (const va of a) {
    for (const vb of b) {
      const d = distance(g, va.x, va.y, vb.x, vb.y);
      if (best === null || d < best.distance) best = { distance: d, from: { x: va.x, y: va.y }, to: { x: vb.x, y: vb.y } };
    }
  }
  return best;
}

/**
 * Every player (Natars excluded) that owns at least one village within `radius` fields of any village in `mine`.
 * For each: the closest pair of villages, and how many of their villages are inside the radius.
 * A player is "nearby" exactly when their closest approach is <= radius, so the list and the Distance column agree.
 * @param {object} map compact village map (ver >= 2)
 * @param {Array<{x:number,y:number}>} mine
 * @returns {Map<number, {distance:number, from:{x,y}, to:{x,y}, inRange:number}>}
 */
function nearbyPlayers(g, map, mine, radius, { exclude = null, natarTribe = 5 } = {}) {
  const out = new Map();
  if (!mine.length || !(radius >= 0)) return out;
  const r2 = radius * radius;
  const n = map.u.length;
  for (let v = 0; v < n; v++) {
    if (map.t[v] === natarTribe) continue;
    const id = map.pi[map.u[v]];
    if (id === exclude) continue;
    const x = map.x[v];
    const y = map.y[v];
    let best = Infinity;
    let from = null;
    for (const m of mine) {
      const dx = axisDelta(g, m.x, x);
      if (dx > radius) continue;
      const dy = axisDelta(g, m.y, y);
      const d2 = dx * dx + dy * dy;
      if (d2 < best) {
        best = d2;
        from = m;
      }
    }
    if (best > r2) continue;
    const cur = out.get(id);
    if (!cur) out.set(id, { distance: Math.sqrt(best), from: { x: from.x, y: from.y }, to: { x, y }, inRange: 1 });
    else {
      cur.inRange++;
      if (Math.sqrt(best) < cur.distance) {
        cur.distance = Math.sqrt(best);
        cur.from = { x: from.x, y: from.y };
        cur.to = { x, y };
      }
    }
  }
  return out;
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * A circular mean is only meaningful when the villages are clustered on the circle. The "mean resultant length"
 * (1 = all in one spot, 0 = spread evenly all around) below this value means the centre would be an accident of
 * rounding, so no centre is reported. 0.05 corresponds to two equal villages about 190 fields apart on a 401-wide map.
 */
const MIN_CLUSTERING = 0.05;

/** Wraps a coordinate into [-radius - 0.5, radius + 0.5). */
function wrapCoord(v, g) {
  const lo = -g.radius - 0.5;
  return ((((v - lo) % g.size) + g.size) % g.size) + lo;
}

/**
 * Population-weighted centre of a player's villages plus their spread.
 * @returns {{x:number, y:number, spread:number, villages:number}|null} null when there are no villages, or when
 *   the villages are spread evenly around the whole world so that no meaningful centre exists.
 */
function centre(g, villages) {
  if (!villages.length) return null;
  const weight = (v) => Math.max(1, v.pop || 0);
  let total = 0;
  for (const v of villages) total += weight(v);

  let cx;
  let cy;
  if (g.wrap && g.size) {
    const k = (2 * Math.PI) / g.size;
    let xc = 0, xs = 0, yc = 0, ys = 0;
    for (const v of villages) {
      const w = weight(v);
      const ax = (v.x + g.radius + 0.5) * k;
      const ay = (v.y + g.radius + 0.5) * k;
      xc += w * Math.cos(ax);
      xs += w * Math.sin(ax);
      yc += w * Math.cos(ay);
      ys += w * Math.sin(ay);
    }
    // the villages cancel out around the circle: there is no meaningful centre
    if (Math.hypot(xc, xs) / total < MIN_CLUSTERING || Math.hypot(yc, ys) / total < MIN_CLUSTERING) return null;
    cx = wrapCoord(Math.atan2(xs, xc) / k - g.radius - 0.5, g);
    cy = wrapCoord(Math.atan2(ys, yc) / k - g.radius - 0.5, g);
  } else {
    cx = villages.reduce((s, v) => s + weight(v) * v.x, 0) / total;
    cy = villages.reduce((s, v) => s + weight(v) * v.y, 0) / total;
  }
  const spread = villages.reduce((s, v) => s + weight(v) * distance(g, cx, cy, v.x, v.y), 0) / total;
  return { x: round1(cx), y: round1(cy), spread: round1(spread), villages: villages.length };
}

/** The capital if the file flags one, otherwise the biggest village. */
function mainVillage(villages) {
  if (!villages.length) return null;
  const cap = villages.find((v) => v.capital);
  const v = cap || villages.reduce((a, b) => (b.pop > a.pop ? b : a));
  return { x: v.x, y: v.y, capital: Boolean(cap), name: v.name };
}

module.exports = { worldGeometry, axisDelta, distance, villagesByPlayer, closestApproach, nearbyPlayers, centre, mainVillage, round1 };
