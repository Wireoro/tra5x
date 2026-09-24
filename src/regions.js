'use strict';

const { NATAR_TRIBE } = require('./travian');
const { CompareError, pickReference } = require('./compare');

const DAY = 86400000;
const GROWTH_HORIZONS = [1, 3, 7]; // days shown in the region dialog

/**
 * Villages in `map` that fall in region `key` (Natars excluded, same as the stored region totals), grouped by
 * alliance. Reads the compact map kept by the ingestion (aggregate.js, map ver >= 3, which adds the per-village
 * region index rg / the region name lookup rn), so this is always the CURRENT snapshot's breakdown - there is no
 * stored history of who held a region, only of the region's own totals (see buildRegionDetail).
 * @returns {{villages:number, population:number, alliances:object[]}|null} null when the map has no region data
 *   (ver < 3, or an older cached map from before this feature)
 */
function regionAllianceBreakdown(map, key) {
  if (!map || !Array.isArray(map.rg) || !Array.isArray(map.rn) || !Array.isArray(map.t)) return null;
  const ri = map.rn.indexOf(key);
  if (ri === -1) return { villages: 0, population: 0, alliances: [] };

  const byAlliance = new Map(); // allianceId ?? 'none' -> {alliance_id, alliance_tag, villages, population}
  let villages = 0;
  let population = 0;
  for (let v = 0; v < map.rg.length; v++) {
    if (map.rg[v] !== ri || map.t[v] === NATAR_TRIBE) continue;
    villages++;
    population += map.p[v];
    const a = map.a[v];
    const allianceId = a >= 0 ? map.ai[a] : null;
    const allianceTag = a >= 0 ? map.at[a] : null;
    const bucketKey = allianceId ?? 'none';
    let b = byAlliance.get(bucketKey);
    if (!b) {
      b = { alliance_id: allianceId, alliance_tag: allianceTag, villages: 0, population: 0 };
      byAlliance.set(bucketKey, b);
    }
    b.villages++;
    b.population += map.p[v];
  }
  const alliances = [...byAlliance.values()]
    .map((b) => ({ ...b, village_share: villages ? b.villages / villages : 0, population_share: population ? b.population / population : 0 }))
    .sort((a, b) => b.population - a.population || b.villages - a.villages);
  return { villages, population, alliances };
}

/** Villages / population gained over the last `days` days, picking the stored point closest to that age (see compare.js). */
function growthAt(series, latest, days) {
  if (series.length < 2) return null;
  const ref = pickReference(series, days);
  if (!ref) return null;
  const actualDays = (Date.parse(latest.taken_at) - Date.parse(ref.taken_at)) / DAY;
  return {
    requested_days: days,
    actual_days: Math.round(actualDays * 100) / 100,
    from: ref.taken_at,
    villages_gain: latest.villages - ref.villages,
    population_gain: latest.population - ref.population,
    population_gain_pct: ref.population > 0 ? (latest.population - ref.population) / ref.population : null,
    truncated: actualDays < days * 0.8,
  };
}

/**
 * Everything the region dialog needs: the region's own history (villages / population have been tracked once a
 * day since the region breakdown was added, same as any other tab), the growth over 1 / 3 / 7 days computed from
 * it, and which alliances currently hold the region, read live off the village map (see regionAllianceBreakdown -
 * there is no historical version of that breakdown, so it always reflects the latest snapshot).
 */
async function buildRegionDetail(store, world, key, { getMap = null } = {}) {
  const series = await store.getSnapshotSeries(world, 400);
  if (!series.length) throw new CompareError(503, 'No snapshot has been stored yet.');
  const ids = series.map((s) => s.id);
  const takenAt = new Map(series.map((s) => [s.id, s.taken_at]));
  const allRows = await store.getBreakdowns(ids, 'region');

  const latestSnap = series[series.length - 1];
  const latestRows = allRows.filter((r) => r.snapshot_id === latestSnap.id).sort((a, b) => b.villages - a.villages);
  const rank = latestRows.findIndex((r) => r.key === key) + 1;
  if (!rank) throw new CompareError(404, `No region named "${key}" in the latest snapshot.`);

  const history = allRows
    .filter((r) => r.key === key)
    .map((r) => ({ taken_at: takenAt.get(r.snapshot_id), villages: r.villages, population: Number(r.population) }))
    .sort((a, b) => Date.parse(a.taken_at) - Date.parse(b.taken_at));
  const latest = history[history.length - 1];

  const growth = {};
  for (const d of GROWTH_HORIZONS) growth[`d${d}`] = growthAt(history, latest, d);

  let live = null;
  if (getMap) {
    try {
      live = regionAllianceBreakdown(await getMap(), key);
    } catch {
      live = null;
    }
  }

  return {
    world,
    region: key,
    snapshot: { taken_at: latest.taken_at },
    rank,
    regions_tracked: latestRows.length,
    totals: { villages: latest.villages, population: latest.population, avg_population: latest.villages ? latest.population / latest.villages : 0 },
    growth,
    history: history.slice(-200), // enough for a chart; keeps the response small on long-running worlds
    alliances: live ? live.alliances : [],
    alliances_available: live !== null,
  };
}

module.exports = { buildRegionDetail, regionAllianceBreakdown };
