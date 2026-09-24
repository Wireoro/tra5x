'use strict';

const int = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const server = String(process.env.TRAVIAN_SERVER || 'rog.x5.international.travian.com')
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/[/?#].*$/, '')
  .toLowerCase();

if (!/^[a-z0-9.-]+$/.test(server)) {
  throw new Error(`TRAVIAN_SERVER must be a bare hostname, got "${server}"`);
}

const supabaseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const supabaseKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

let storeKind = String(process.env.STORE || '').trim().toLowerCase();
if (!storeKind) storeKind = supabaseUrl && supabaseKey ? 'supabase' : 'memory';

module.exports = {
  port: int(process.env.PORT, 3000),

  // Travian world
  world: server,
  mapUrl: process.env.MAP_SQL_URL || `https://${server}/map.sql`,
  mapFile: process.env.MAP_SQL_FILE || '', // read a local map.sql instead of downloading (dev / offline)
  // Map geometry for distances. The size is inferred from the extent of the tiles in map.sql; set MAP_RADIUS
  // (e.g. 200 for a 401 x 401 map) to override it, and MAP_WRAP=false for worlds with hard edges.
  mapRadius: Math.max(0, int(process.env.MAP_RADIUS, 0)),
  mapWrap: !/^(0|false|no|off)$/i.test(process.env.MAP_WRAP || 'true'),
  userAgent: process.env.USER_AGENT || 'Tra5x/1.0 (community stats dashboard)',

  // Storage
  storeKind, // 'supabase' | 'memory'
  supabaseUrl,
  supabaseKey,
  // Per-day player history: 0 = every player (default), N = only the top N players by population.
  historyTopPlayers: Math.max(0, int(process.env.HISTORY_TOP_PLAYERS, 0)),
  // Delete snapshots (and their history / events) older than this many days. 0 = keep everything.
  retentionDays: Math.max(0, int(process.env.HISTORY_RETENTION_DAYS, 0)),
  // Village change detection is skipped when a single day produces more changes than this (world reset guard).
  maxVillageEvents: int(process.env.MAX_VILLAGE_EVENTS, 30000),
  // Size of your Supabase database plan (free tier = 500 MB); only used for the usage indicator in /api/status.
  dbSizeLimitMb: int(process.env.DB_SIZE_LIMIT_MB, 500),

  // Refresh policy. Travian regenerates map.sql once per day at server midnight, so once a
  // snapshot is stored we stay quiet for `refreshAfterHours`, then poll every `pollMinutes`
  // (conditional GET / content-hash check) until a new file shows up.
  autoRefresh: !/^(0|false|no|off)$/i.test(process.env.AUTO_REFRESH || 'true'),
  refreshAfterHours: Number(process.env.REFRESH_AFTER_HOURS || 20),
  pollMinutes: int(process.env.REFRESH_POLL_MINUTES, 60),
  retryMinutes: int(process.env.REFRESH_RETRY_MINUTES, 15),

  // Admin endpoint (POST /api/admin/refresh). Disabled when empty.
  adminToken: process.env.ADMIN_TOKEN || '',

  // Simple per-IP rate limit for /api (requests per minute)
  rateLimitPerMin: int(process.env.RATE_LIMIT_PER_MIN, 240),
};
