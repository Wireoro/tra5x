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
  userAgent: process.env.USER_AGENT || 'Tra5x/1.0 (community stats dashboard)',

  // Storage
  storeKind, // 'supabase' | 'memory'
  supabaseUrl,
  supabaseKey,
  historyTopPlayers: int(process.env.HISTORY_TOP_PLAYERS, 500),

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
