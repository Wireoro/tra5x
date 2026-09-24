'use strict';

const { PostgrestClient } = require('./postgrest');

const SNAPSHOT_SERIES_COLS =
  'id,taken_at,players,alliances,villages,natar_villages,population,capitals,cities,harbors,players_in_alliance,new_players,departed_players';

const PLAYER_COLS = 'id,name,tribe,alliance_id,alliance_tag,villages,population,prev_population,pop_delta,rank,capital_x,capital_y';
const ALLIANCE_COLS = 'id,tag,members,villages,population,prev_population,pop_delta,rank';

const PLAYER_SORTS = new Set(['rank', 'population', 'villages', 'pop_delta', 'name']);
const ALLIANCE_SORTS = new Set(['rank', 'population', 'members', 'villages', 'pop_delta', 'tag']);

/** Makes user input safe for a PostgREST ilike pattern (`*` is the wildcard; `_` is widened to `*`). */
const likeSafe = (s) => String(s).replace(/[%,()\\]/g, ' ').replace(/_/g, '*').trim();

/** Store backed by Supabase (Postgres) through its REST API, using the server-side service role key. */
class SupabaseStore {
  constructor({ url, key }) {
    this.kind = 'supabase';
    this.db = new PostgrestClient(url, key);
  }

  // ---- writes ---------------------------------------------------------------------------

  async ingest(payload, map) {
    const id = await this.db.rpc('ingest_snapshot', { p: payload }, { timeoutMs: 180000 });
    if (!Number.isFinite(Number(id))) throw new Error(`ingest_snapshot returned an unexpected value: ${JSON.stringify(id)}`);
    await this.db.upsert(
      'map_cache',
      { world: payload.world, snapshot_id: Number(id), updated_at: new Date().toISOString(), payload: map },
      { onConflict: 'world', timeoutMs: 180000 },
    );
    return Number(id);
  }

  async logStart(world) {
    const rows = await this.db.insert('ingest_log', { world, status: 'running' }, { returning: true });
    return rows?.[0]?.id ?? null;
  }

  async logFinish(id, { status, message, snapshotId }) {
    if (id == null) return;
    await this.db.update(
      'ingest_log',
      { finished_at: new Date().toISOString(), status, message: message ? String(message).slice(0, 1000) : null, snapshot_id: snapshotId ?? null },
      [['id', 'eq', id]],
    );
  }

  // ---- reads ----------------------------------------------------------------------------

  async getRecentSnapshots(world, n = 2) {
    const { rows } = await this.db.select('snapshots', { filters: [['world', 'eq', world]], order: 'taken_at.desc', limit: n });
    return rows;
  }

  async getSnapshotSeries(world, limit = 400) {
    const { rows } = await this.db.select('snapshots', {
      select: SNAPSHOT_SERIES_COLS,
      filters: [['world', 'eq', world]],
      order: 'taken_at.desc',
      limit,
    });
    return rows.reverse();
  }

  async getTribeStats(snapshotIds) {
    if (!snapshotIds.length) return [];
    return this.db.selectAll('tribe_stats', { filters: [['snapshot_id', 'in', snapshotIds]], order: 'snapshot_id.asc,tribe.asc' });
  }

  async listPlayers(world, o = {}) {
    const filters = [['world', 'eq', world]];
    if (o.q) filters.push(['name', 'ilike', `*${likeSafe(o.q)}*`]);
    if (o.tribe != null) filters.push(['tribe', 'eq', o.tribe]);
    if (o.alliance != null) filters.push(['alliance_id', 'eq', o.alliance]);
    if (o.tag) filters.push(['alliance_tag', 'ilike', likeSafe(o.tag)]);
    const sort = PLAYER_SORTS.has(o.sort) ? o.sort : 'rank';
    const dir = o.dir === 'desc' ? 'desc' : 'asc';
    return this.db.select('players', {
      select: PLAYER_COLS,
      filters,
      order: `${sort}.${dir}.nullslast,id.asc`,
      limit: o.limit ?? 50,
      offset: o.offset ?? 0,
      count: true,
    });
  }

  async getPlayer(world, id) {
    const { rows } = await this.db.select('players', { select: PLAYER_COLS, filters: [['world', 'eq', world], ['id', 'eq', id]], limit: 1 });
    return rows[0] || null;
  }

  async getPlayerHistory(playerId, limit = 400) {
    const { rows } = await this.db.select('player_history', {
      select: 'population,villages,alliance_id,snapshot_id,snapshots(taken_at)',
      filters: [['player_id', 'eq', playerId]],
      order: 'snapshot_id.desc',
      limit,
    });
    return rows
      .map((r) => ({ taken_at: r.snapshots?.taken_at, population: r.population, villages: r.villages, alliance_id: r.alliance_id }))
      .filter((r) => r.taken_at)
      .reverse();
  }

  async listAlliances(world, o = {}) {
    const filters = [['world', 'eq', world]];
    if (o.q) filters.push(['tag', 'ilike', `*${likeSafe(o.q)}*`]);
    const sort = ALLIANCE_SORTS.has(o.sort) ? o.sort : 'rank';
    const dir = o.dir === 'desc' ? 'desc' : 'asc';
    return this.db.select('alliances', {
      select: ALLIANCE_COLS,
      filters,
      order: `${sort}.${dir}.nullslast,id.asc`,
      limit: o.limit ?? 50,
      offset: o.offset ?? 0,
      count: true,
    });
  }

  async getAlliance(world, id) {
    const { rows } = await this.db.select('alliances', { select: ALLIANCE_COLS, filters: [['world', 'eq', world], ['id', 'eq', id]], limit: 1 });
    return rows[0] || null;
  }

  async getAllianceHistory(allianceIds, snapshotIds) {
    if (!allianceIds.length || !snapshotIds.length) return [];
    const rows = await this.db.selectAll('alliance_history', {
      select: 'alliance_id,tag,members,villages,population,snapshot_id,snapshots(taken_at)',
      filters: [['alliance_id', 'in', allianceIds], ['snapshot_id', 'in', snapshotIds]],
      order: 'snapshot_id.asc,alliance_id.asc',
    });
    return rows.map((r) => ({
      alliance_id: r.alliance_id,
      tag: r.tag,
      members: r.members,
      villages: r.villages,
      population: r.population,
      taken_at: r.snapshots?.taken_at,
    }));
  }

  async getMovers(world, dir, limit = 15) {
    const gain = dir === 'gain';
    const { rows } = await this.db.select('players', {
      select: PLAYER_COLS,
      filters: [['world', 'eq', world], ['pop_delta', gain ? 'gt' : 'lt', 0]],
      order: `pop_delta.${gain ? 'desc' : 'asc'},id.asc`,
      limit,
    });
    return rows;
  }

  async getMap(world) {
    const { rows } = await this.db.select('map_cache', { filters: [['world', 'eq', world]], limit: 1 });
    return rows[0] || null;
  }

  async getIngestLog(world, n = 5) {
    const { rows } = await this.db.select('ingest_log', { filters: [['world', 'eq', world]], order: 'started_at.desc', limit: n });
    return rows;
  }
}

module.exports = { SupabaseStore };
