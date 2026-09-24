'use strict';

const { NATAR_TRIBE } = require('./travian');
const { CompareError, pickReference } = require('./compare');
const { regionAllianceKey } = require('./aggregate');

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
    ref_snapshot_id: ref.id,
    villages_gain: latest.villages - ref.villages,
    population_gain: latest.population - ref.population,
    population_gain_pct: ref.population > 0 ? (latest.population - ref.population) / ref.population : null,
    truncated: actualDays < days * 0.8,
  };
}

/**
 * Villages in `map` belonging to `allianceId`, grouped by region (the mirror image of
 * regionAllianceBreakdown: that one fixes a region and lists alliances, this one fixes an alliance and lists
 * regions). Each region's `village_share` / `population_share` is this alliance's share OF THAT REGION (so
 * "how much of the region it controls"), computed from the region's own total in the same map pass. Live off
 * the current map only, same caveat as regionAllianceBreakdown - no stored history of who held what, only of
 * the region_alliance totals (see buildAllianceTerritory).
 * @returns {{regions:object[]}|null} null when the map has no region data (ver < 3, or an older cached map)
 */
function allianceRegionBreakdown(map, allianceId) {
  if (!map || !Array.isArray(map.rg) || !Array.isArray(map.rn) || !Array.isArray(map.t)) return null;

  const regionTotals = map.rn.map(() => ({ villages: 0, population: 0 }));
  const mine = new Map(); // region index -> {villages, population}
  for (let v = 0; v < map.rg.length; v++) {
    const ri = map.rg[v];
    if (ri === -1 || map.t[v] === NATAR_TRIBE) continue;
    const rt = regionTotals[ri];
    rt.villages++;
    rt.population += map.p[v];

    const a = map.a[v];
    const thisAlliance = a >= 0 ? map.ai[a] : null;
    if (thisAlliance !== allianceId) continue;
    let m = mine.get(ri);
    if (!m) {
      m = { villages: 0, population: 0 };
      mine.set(ri, m);
    }
    m.villages++;
    m.population += map.p[v];
  }

  const regions = [...mine.entries()]
    .map(([ri, m]) => {
      const rt = regionTotals[ri];
      return {
        region: map.rn[ri],
        villages: m.villages,
        population: m.population,
        village_share: rt.villages ? m.villages / rt.villages : 0,
        population_share: rt.population ? m.population / rt.population : 0,
      };
    })
    .sort((a, b) => b.population - a.population || b.villages - a.villages);
  return { regions };
}

/**
 * Fills in `growth.d1/d3/d7` on each of `items` from the region_alliance breakdown stored for exactly the
 * reference snapshots picked for `ownGrowth` (a region's own growth, when pivoting by alliance for
 * buildRegionDetail; or an alliance's own growth, when pivoting by region for buildAllianceTerritory) - both
 * directions read the same region_alliance rows, just keyed the other way round, via `keyFor(item)`. This is
 * new tracked history (see aggregate.js buildBreakdowns), so an item with no stored row at a reference point
 * (new to the region/alliance pairing, or simply not tracked yet because this feature only started recording
 * from whenever it was deployed) gets `null` for that horizon rather than a misleading gain-from-zero.
 */
async function fillPairedGrowth(store, items, keyFor, ownGrowth) {
  for (const it of items) it.growth = { d1: null, d3: null, d7: null };
  if (!items.length) return;

  const refSnapshotIds = [...new Set(GROWTH_HORIZONS.map((d) => ownGrowth[`d${d}`]?.ref_snapshot_id).filter((id) => id != null))];
  if (!refSnapshotIds.length) return;

  const wantedKeys = [...new Set(items.map(keyFor))];
  const refRows = await store.getBreakdowns(refSnapshotIds, 'region_alliance', wantedKeys);
  const bySnapshotAndKey = new Map(refRows.map((r) => [`${r.snapshot_id}:${r.key}`, r]));

  for (const it of items) {
    const key = keyFor(it);
    for (const d of GROWTH_HORIZONS) {
      const g = ownGrowth[`d${d}`];
      const past = g?.ref_snapshot_id != null ? bySnapshotAndKey.get(`${g.ref_snapshot_id}:${key}`) : null;
      if (!past) continue; // stays null: no stored row for this pairing at that reference point
      const pastPop = Number(past.population);
      it.growth[`d${d}`] = {
        villages_gain: it.villages - past.villages,
        population_gain: it.population - pastPop,
        population_gain_pct: pastPop > 0 ? (it.population - pastPop) / pastPop : null,
      };
    }
  }
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
    .map((r) => ({ id: r.snapshot_id, taken_at: takenAt.get(r.snapshot_id), villages: r.villages, population: Number(r.population) }))
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
  if (live) {
    try {
      await fillPairedGrowth(store, live.alliances, (a) => regionAllianceKey(key, a.alliance_id), growth);
    } catch {
      // leave the alliances' growth at the default (all null, set at the top of fillPairedGrowth) -
      // the dominance table itself still works, it just can't show 24h/3d/7d change for this request.
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

/**
 * Everything the "Alliance region control" dialog needs, mirroring buildRegionDetail: the alliance's own
 * population history and growth over 1/3/7 days (from alliance_history, exactly what the ordinary alliance
 * dialog already uses), and which regions it currently holds villages in, read live off the village map (see
 * allianceRegionBreakdown - no historical version of that breakdown, so it always reflects the latest
 * snapshot; region-by-region growth is filled in from region_alliance history the same way
 * buildRegionDetail does it, just the other way round).
 */
async function buildAllianceTerritory(store, world, allianceId, { getMap = null } = {}) {
  const series = await store.getSnapshotSeries(world, 400);
  if (!series.length) throw new CompareError(503, 'No snapshot has been stored yet.');

  const alliance = await store.getAlliance(world, allianceId);
  if (!alliance) throw new CompareError(404, `No alliance with id ${allianceId}.`);

  const ids = series.map((s) => s.id);
  const histRows = await store.getAllianceHistory([allianceId], ids);

  const history = histRows
    .map((r) => ({ id: r.snapshot_id, taken_at: r.taken_at, villages: r.villages, population: Number(r.population) }))
    .sort((a, b) => Date.parse(a.taken_at) - Date.parse(b.taken_at));
  const latest = history[history.length - 1] || { villages: alliance.villages, population: alliance.population, taken_at: series[series.length - 1].taken_at };

  const growth = {};
  for (const d of GROWTH_HORIZONS) growth[`d${d}`] = growthAt(history, latest, d);

  let live = null;
  if (getMap) {
    try {
      live = allianceRegionBreakdown(await getMap(), allianceId);
    } catch {
      live = null;
    }
  }
  if (live) {
    try {
      await fillPairedGrowth(store, live.regions, (r) => regionAllianceKey(r.region, allianceId), growth);
    } catch {
      // leave the regions' growth at the default (all null) - the control table itself still works.
    }
  }

  return {
    world,
    alliance_id: allianceId,
    alliance_tag: alliance.tag,
    totals: { members: alliance.members, villages: alliance.villages, population: alliance.population },
    growth,
    history: history.slice(-200),
    regions: live ? live.regions : [],
    regions_available: live !== null,
  };
}

module.exports = { buildRegionDetail, buildAllianceTerritory, regionAllianceBreakdown, allianceRegionBreakdown };
