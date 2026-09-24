'use strict';

// One-shot ingestion: `npm run ingest` or `node src/cli-ingest.js --force`.
// Useful for a Render cron job / GitHub Action if you prefer not to rely on the in-app scheduler.

const config = require('./config');
const { createStore } = require('./store');
const { Ingestor } = require('./ingest');

(async () => {
  const store = createStore(config);
  const ingestor = new Ingestor({ store, config });
  const result = await ingestor.run({ force: process.argv.includes('--force'), reason: 'cli' });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.status === 'error' ? 1 : 0);
})();
