'use strict';

/**
 * Local demo with SYNTHETIC data (not rog.x5): builds a fake world, replays N game days into the
 * in-memory store and serves the dashboard. Usage: npm run demo -- --days 21 --players 1500 --port 3000
 */
const crypto = require('node:crypto');
const baseConfig = require('../src/config');
const { createApp } = require('../src/server');
const { MemoryStore } = require('../src/store/memory');
const { parseMapSql } = require('../src/parser');
const { aggregate } = require('../src/aggregate');
const { createWorld, advance, toMapSql } = require('./fixture');

const arg = (name, d) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : d;
};

async function main() {
  const days = arg('days', 21);
  const players = arg('players', 1500);
  const port = arg('port', 3000);
  const world = createWorld({ seed: 42, radius: 200, players, alliances: 16, regions: true });
  const store = new MemoryStore();
  const config = { ...baseConfig, port, world: 'demo.synthetic', mapUrl: 'synthetic demo data', mapFile: '', autoRefresh: false, storeKind: 'memory', historyTopPlayers: 500 };

  for (let d = 0; d <= days; d++) {
    if (d > 0) advance(world);
    const text = toMapSql(world);
    const parsed = parseMapSql(text);
    const agg = aggregate(parsed.rows);
    const takenAt = new Date(Date.now() - (days - d) * 86400000).toISOString();
    await store.ingest({
      ...agg.payload,
      world: config.world,
      taken_at: takenAt,
      source_url: 'synthetic',
      content_hash: crypto.createHash('sha256').update(text).digest('hex'),
      history_top_players: 500,
    }, agg.map);
  }

  const app = createApp({ config, store, logger: { log() {}, warn() {}, error: console.error } });
  app.server.listen(port, '127.0.0.1', () => console.log(`Tra5x demo (synthetic data, ${days + 1} daily snapshots) on http://127.0.0.1:${port}`));
}

main();
