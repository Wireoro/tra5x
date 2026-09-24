'use strict';

/**
 * Village-level change detection between two consecutive compact maps (see aggregate.js, map ver >= 2).
 * A village is identified by its tile (x, y):
 *   - tile not occupied before, occupied now      -> village_founded
 *   - occupied before and now by different owners  -> village_conquered (player = new owner, from_player = old owner)
 *   - occupied before, not occupied now            -> village_abandoned (player = former owner)
 * Natars are ordinary owners here: taking a Natar village is a conquest from the Natar player.
 */

const tileKey = (x, y) => (x + 100000) * 200003 + (y + 100000);

function ownerAt(m, i) {
  const u = m.u[i];
  const a = m.a[i];
  return {
    player_id: m.pi[u] ?? null,
    player_name: m.pn[u] ?? null,
    alliance_id: a >= 0 ? (m.ai[a] ?? null) : null,
    alliance_tag: a >= 0 ? (m.at[a] ?? null) : null,
  };
}

const comparable = (m) => m && m.ver >= 2 && Array.isArray(m.pi) && Array.isArray(m.ai) && Array.isArray(m.v);

/**
 * @returns {{events: object[], skipped: string|null}} `skipped` explains why no events were produced
 *   (no comparable baseline, or an implausible number of changes such as a world reset).
 */
function diffVillages(prev, next, { maxEvents = 30000 } = {}) {
  if (!comparable(prev) || !comparable(next)) return { events: [], skipped: 'previous map has no ids (older format)' };

  const index = new Map();
  for (let j = 0; j < prev.x.length; j++) index.set(tileKey(prev.x[j], prev.y[j]), j);
  const matched = new Uint8Array(prev.x.length);
  const events = [];

  for (let i = 0; i < next.x.length; i++) {
    const j = index.get(tileKey(next.x[i], next.y[i]));
    const cur = ownerAt(next, i);
    const tile = { x: next.x[i], y: next.y[i], village_id: next.v[i] || null, village_name: next.n[i] || null, population: next.p[i] };
    if (j === undefined) {
      events.push({ kind: 'village_founded', ...tile, ...cur });
    } else {
      matched[j] = 1;
      const old = ownerAt(prev, j);
      if (old.player_id !== cur.player_id) {
        events.push({
          kind: 'village_conquered',
          ...tile,
          ...cur,
          from_player_id: old.player_id,
          from_player_name: old.player_name,
          from_alliance_id: old.alliance_id,
          from_alliance_tag: old.alliance_tag,
        });
      }
    }
    if (events.length > maxEvents) return { events: [], skipped: `more than ${maxEvents} village changes (world reset?)` };
  }

  for (let j = 0; j < prev.x.length; j++) {
    if (matched[j]) continue;
    events.push({
      kind: 'village_abandoned',
      x: prev.x[j],
      y: prev.y[j],
      village_id: prev.v[j] || null,
      village_name: prev.n[j] || null,
      population: prev.p[j],
      ...ownerAt(prev, j),
    });
    if (events.length > maxEvents) return { events: [], skipped: `more than ${maxEvents} village changes (world reset?)` };
  }

  return { events, skipped: null };
}

module.exports = { diffVillages, tileKey };
