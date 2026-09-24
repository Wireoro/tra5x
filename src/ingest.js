'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const zlib = require('node:zlib');

const { fetchMapSql } = require('./travian');
const { iterateRows } = require('./parser');
const { aggregate } = require('./aggregate');

const MIN_CHECK_GAP_MS = 5 * 60 * 1000;

/**
 * Orchestrates: download map.sql -> (skip if unchanged) -> parse -> aggregate -> store.
 * `maybeRefresh()` is cheap and safe to call often (boot, timer, API traffic): it decides by itself
 * whether a download is due.
 */
class Ingestor {
  constructor({ store, config, logger = console, fetcher = fetchMapSql, onIngested = null }) {
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.fetcher = fetcher;
    this.onIngested = onIngested;
    this.running = false;
    this.lastCheckAt = 0;
    this.lastAttemptAt = 0;
    this.lastResult = null;
  }

  state() {
    return { running: this.running, lastAttemptAt: this.lastAttemptAt ? new Date(this.lastAttemptAt).toISOString() : null, lastResult: this.lastResult };
  }

  async load(latest, force) {
    const { config } = this;
    if (config.mapFile) {
      let buffer = await fs.readFile(config.mapFile);
      if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = zlib.gunzipSync(buffer);
      const st = await fs.stat(config.mapFile);
      return { buffer, etag: null, lastModified: st.mtime.toISOString(), finalUrl: `file:${config.mapFile}` };
    }
    return this.fetcher(config.mapUrl, {
      etag: force ? null : latest?.etag,
      lastModified: force ? null : latest?.source_last_modified,
      userAgent: config.userAgent,
    });
  }

  /** Runs one ingestion. Never throws; returns {status, ...}. */
  async run({ force = false, reason = 'manual' } = {}) {
    if (this.running) return { status: 'busy', message: 'An ingestion is already running' };
    this.running = true;
    this.lastAttemptAt = Date.now();
    const started = Date.now();
    const { store, config, logger } = this;
    let logId = null;
    let result;
    try {
      logId = await store.logStart(config.world).catch((e) => {
        logger.warn(`[tra5x] could not write ingest_log: ${e.message}`);
        return null;
      });
      const [latest] = await store.getRecentSnapshots(config.world, 1);
      logger.log(`[tra5x] ingest start (${reason}${force ? ', forced' : ''}) ${config.mapFile || config.mapUrl}`);

      const src = await this.load(latest, force);
      if (src.notModified) {
        result = { status: 'unchanged', message: 'Not modified since the last snapshot (HTTP 304)', snapshotId: latest?.id ?? null };
      } else {
        const hash = crypto.createHash('sha256').update(src.buffer).digest('hex');
        if (latest && latest.content_hash === hash) {
          result = { status: 'unchanged', message: 'Identical to the last snapshot', snapshotId: latest.id };
        } else {
          const text = src.buffer.toString('utf8');
          src.buffer = null; // release the raw bytes before parsing (large worlds)
          if (/^\s*</.test(text.slice(0, 200))) {
            throw new Error(`The server returned HTML instead of map.sql (content-type "${src.contentType || 'unknown'}"). It may be down for maintenance or blocking this request.`);
          }
          const pstats = { tuples: 0, skipped: 0 };
          const agg = aggregate(iterateRows(text, pstats));
          if (agg.payload.totals.tiles === 0) {
            const head = text.slice(0, 160).replace(/[^\x20-\x7e]+/g, ' ');
            throw new Error(`No x_world rows could be parsed (${pstats.tuples} tuples, ${pstats.skipped} skipped). File starts with: "${head}"`);
          }
          if (!force && latest && latest.tiles > 0 && agg.payload.totals.tiles < latest.tiles * 0.5) {
            throw new Error(`Refusing to ingest: the file has ${agg.payload.totals.tiles} rows vs ${latest.tiles} in the last snapshot (truncated download?). Re-run with force to override.`);
          }
          const payload = {
            ...agg.payload,
            world: config.world,
            source_url: src.finalUrl || config.mapUrl,
            content_hash: hash,
            etag: src.etag || null,
            source_last_modified: src.lastModified || null,
            history_top_players: config.historyTopPlayers,
          };
          payload.meta = { ...payload.meta, parser: { tuples: pstats.tuples, skipped: pstats.skipped, bytes: text.length } };
          const snapshotId = await store.ingest(payload, agg.map);
          result = {
            status: 'ok',
            snapshotId,
            message: `Stored snapshot ${snapshotId}: ${payload.totals.players} players, ${payload.totals.alliances} alliances, ${payload.totals.villages} villages`,
            totals: payload.totals,
          };
          if (this.onIngested) this.onIngested(result);
        }
      }
    } catch (err) {
      result = { status: 'error', message: err && err.message ? err.message : String(err) };
      logger.error(`[tra5x] ingest failed: ${result.message}`);
    }
    result.durationMs = Date.now() - started;
    this.lastResult = { ...result, at: new Date().toISOString() };
    logger.log(`[tra5x] ingest ${result.status} in ${result.durationMs}ms - ${result.message}`);
    await store.logFinish(logId, { status: result.status, message: result.message, snapshotId: result.snapshotId }).catch(() => {});
    this.running = false;
    return result;
  }

  /** Decides whether a download is due and, if so, runs it. Safe to call from anywhere, any time. */
  async maybeRefresh() {
    const { config } = this;
    if (!config.autoRefresh || this.running) return null;
    const now = Date.now();
    if (now - this.lastCheckAt < MIN_CHECK_GAP_MS) return null;
    this.lastCheckAt = now;

    const gapMin = this.lastResult?.status === 'error' ? config.retryMinutes : config.pollMinutes;
    if (this.lastAttemptAt && now - this.lastAttemptAt < gapMin * 60 * 1000) return null;

    try {
      const [latest] = await this.store.getRecentSnapshots(config.world, 1);
      if (latest && now - Date.parse(latest.taken_at) < config.refreshAfterHours * 3600 * 1000) return null;
    } catch (err) {
      this.logger.error(`[tra5x] refresh check failed: ${err.message}`);
      return null;
    }
    return this.run({ reason: 'auto' });
  }
}

module.exports = { Ingestor };
