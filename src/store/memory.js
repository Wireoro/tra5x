'use strict';

const PLAYER_SORTS = new Set(['rank', 'population', 'villages', 'pop_delta', 'name']);
const ALLIANCE_SORTS = new Set(['rank', 'population', 'members', 'villages', 'pop_delta', 'tag']);

function cmp(a, b, dir) {
  // nulls last regardless of direction
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const r = typeof a === 'string' ? a.localeCompare(b, undefined, { sensitivity: 'base' }) : a - b;
  return dir === 'desc' ? -r : r;
}

/**
 * In-memory store with the same interface (and the same semantics as the `ingest_snapshot`
 * SQL function). Used for local demos, tests and when Supabase credentials are absent.
 */
class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.seq = 0;
    this.snapshots = [];
    this.tribeStats = [];
    this.players = new Map(); // `${world}:${id}` -> row
    this.alliances = new Map();
    this.playerHistory = [];
    this.allianceHistory = [];
    this.maps = new Map();
    this.log = [];
  }

  async ingest(payload, map) {
    const world = payload.world;
    const existing = this.snapshots.find((s) => s.world === world && s.content_hash === payload.content_hash);
    if (existing) return existing.id;

    const id = ++this.seq;
    const t = payload.totals || {};
    const hadBaseline = this.snapshots.some((s) => s.world === world);
    const snap = {
      id,
      world,
      taken_at: payload.taken_at || new Date().toISOString(),
      source_url: payload.source_url || null,
      content_hash: payload.content_hash,
      etag: payload.etag || null,
      source_last_modified: payload.source_last_modified || null,
      tiles: t.tiles || 0,
      players: t.players || 0,
      alliances: t.alliances || 0,
      villages: t.villages || 0,
      natar_villages: t.natar_villages || 0,
      population: t.population || 0,
      capitals: t.capitals || 0,
      cities: t.cities || 0,
      harbors: t.harbors || 0,
      players_in_alliance: t.players_in_alliance || 0,
      new_players: 0,
      departed_players: 0,
      meta: payload.meta || {},
    };
    this.snapshots.push(snap);

    for (const tr of payload.tribes || []) this.tribeStats.push({ snapshot_id: id, ...tr });

    // players
    const sorted = [...(payload.players || [])].sort((a, b) => b.population - a.population || a.id - b.id);
    let created = 0;
    sorted.forEach((p, i) => {
      const key = `${world}:${p.id}`;
      const old = this.players.get(key);
      if (!old) created++;
      const population = p.population;
      const prev = old ? old.population : null;
      this.players.set(key, {
        world,
        id: p.id,
        name: p.name,
        tribe: p.tribe,
        alliance_id: p.alliance_id ?? null,
        alliance_tag: p.alliance_tag ?? null,
        villages: p.villages,
        population,
        prev_population: prev,
        pop_delta: prev == null ? null : population - prev,
        rank: i + 1,
        capital_x: p.capital_x ?? null,
        capital_y: p.capital_y ?? null,
        first_snapshot_id: old ? old.first_snapshot_id : id,
        last_snapshot_id: id,
      });
    });
    let gone = 0;
    for (const [key, row] of this.players) {
      if (row.world === world && row.last_snapshot_id !== id) {
        this.players.delete(key);
        gone++;
      }
    }
    snap.new_players = hadBaseline ? created : 0;
    snap.departed_players = gone;

    // alliances
    [...(payload.alliances || [])]
      .sort((a, b) => b.population - a.population || a.id - b.id)
      .forEach((a, i) => {
        const key = `${world}:${a.id}`;
        const old = this.alliances.get(key);
        const prev = old ? old.population : null;
        this.alliances.set(key, {
          world,
          id: a.id,
          tag: a.tag,
          members: a.members,
          villages: a.villages,
          population: a.population,
          prev_population: prev,
          pop_delta: prev == null ? null : a.population - prev,
          rank: i + 1,
          last_snapshot_id: id,
        });
        this.allianceHistory.push({ snapshot_id: id, alliance_id: a.id, tag: a.tag, members: a.members, villages: a.villages, population: a.population, taken_at: snap.taken_at });
      });
    for (const [key, row] of this.alliances) if (row.world === world && row.last_snapshot_id !== id) this.alliances.delete(key);

    sorted.slice(0, payload.history_top_players ?? 500).forEach((p) => {
      this.playerHistory.push({ snapshot_id: id, player_id: p.id, population: p.population, villages: p.villages, alliance_id: p.alliance_id ?? null, taken_at: snap.taken_at });
    });

    this.maps.set(world, { world, snapshot_id: id, updated_at: new Date().toISOString(), payload: map });
    return id;
  }

  async logStart(world) {
    const row = { id: this.log.length + 1, world, started_at: new Date().toISOString(), finished_at: null, status: 'running', message: null, snapshot_id: null };
    this.log.push(row);
    return row.id;
  }

  async logFinish(id, { status, message, snapshotId }) {
    const row = this.log.find((r) => r.id === id);
    if (row) Object.assign(row, { finished_at: new Date().toISOString(), status, message: message || null, snapshot_id: snapshotId ?? null });
  }

  async getRecentSnapshots(world, n = 2) {
    return this.snapshots.filter((s) => s.world === world).sort((a, b) => Date.parse(b.taken_at) - Date.parse(a.taken_at) || b.id - a.id).slice(0, n);
  }

  async getSnapshotSeries(world, limit = 400) {
    return this.snapshots
      .filter((s) => s.world === world)
      .sort((a, b) => Date.parse(a.taken_at) - Date.parse(b.taken_at) || a.id - b.id)
      .slice(-limit)
      .map(({ meta, ...rest }) => rest);
  }

  async getTribeStats(snapshotIds) {
    const set = new Set(snapshotIds);
    return this.tribeStats.filter((r) => set.has(r.snapshot_id));
  }

  async listPlayers(world, o = {}) {
    let rows = [...this.players.values()].filter((p) => p.world === world);
    if (o.q) {
      const q = o.q.toLowerCase();
      rows = rows.filter((p) => p.name.toLowerCase().includes(q));
    }
    if (o.tribe != null) rows = rows.filter((p) => p.tribe === o.tribe);
    if (o.alliance != null) rows = rows.filter((p) => p.alliance_id === o.alliance);
    if (o.tag) rows = rows.filter((p) => (p.alliance_tag || '').toLowerCase() === o.tag.toLowerCase());
    const sort = PLAYER_SORTS.has(o.sort) ? o.sort : 'rank';
    const dir = o.dir === 'desc' ? 'desc' : 'asc';
    rows.sort((a, b) => cmp(a[sort], b[sort], dir) || a.id - b.id);
    const total = rows.length;
    return { rows: rows.slice(o.offset || 0, (o.offset || 0) + (o.limit ?? 50)).map(strip), total };
  }

  async getPlayer(world, id) {
    const p = this.players.get(`${world}:${id}`);
    return p ? strip(p) : null;
  }

  async getPlayerHistory(playerId, limit = 400) {
    return this.playerHistory
      .filter((r) => r.player_id === playerId)
      .sort((a, b) => a.snapshot_id - b.snapshot_id)
      .slice(-limit)
      .map(({ taken_at, population, villages, alliance_id }) => ({ taken_at, population, villages, alliance_id }));
  }

  async listAlliances(world, o = {}) {
    let rows = [...this.alliances.values()].filter((a) => a.world === world);
    if (o.q) {
      const q = o.q.toLowerCase();
      rows = rows.filter((a) => a.tag.toLowerCase().includes(q));
    }
    const sort = ALLIANCE_SORTS.has(o.sort) ? o.sort : 'rank';
    const dir = o.dir === 'desc' ? 'desc' : 'asc';
    rows.sort((a, b) => cmp(a[sort], b[sort], dir) || a.id - b.id);
    const total = rows.length;
    return { rows: rows.slice(o.offset || 0, (o.offset || 0) + (o.limit ?? 50)).map(strip), total };
  }

  async getAlliance(world, id) {
    const a = this.alliances.get(`${world}:${id}`);
    return a ? strip(a) : null;
  }

  async getAllianceHistory(allianceIds, snapshotIds) {
    const a = new Set(allianceIds);
    const s = new Set(snapshotIds);
    return this.allianceHistory
      .filter((r) => a.has(r.alliance_id) && s.has(r.snapshot_id))
      .sort((x, y) => x.snapshot_id - y.snapshot_id)
      .map(({ alliance_id, tag, members, villages, population, taken_at }) => ({ alliance_id, tag, members, villages, population, taken_at }));
  }

  async getMovers(world, dir, limit = 15) {
    const gain = dir === 'gain';
    return [...this.players.values()]
      .filter((p) => p.world === world && p.pop_delta != null && (gain ? p.pop_delta > 0 : p.pop_delta < 0))
      .sort((a, b) => (gain ? b.pop_delta - a.pop_delta : a.pop_delta - b.pop_delta) || a.id - b.id)
      .slice(0, limit)
      .map(strip);
  }

  async getMap(world) {
    return this.maps.get(world) || null;
  }

  async getIngestLog(world, n = 5) {
    return this.log.filter((r) => r.world === world).slice(-n).reverse();
  }
}

function strip({ world, first_snapshot_id, last_snapshot_id, ...rest }) {
  return rest;
}

module.exports = { MemoryStore };
