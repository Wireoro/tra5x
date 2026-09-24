'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const gzip = promisify(zlib.gzip);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

function applySecurityHeaders(req, res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('strict-transport-security', 'max-age=31536000');
}

const etagOf = (buf) => `"${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20)}"`;
const acceptsGzip = (req) => /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));

/** Sends a cached-body entry {raw, gz?, etag, type}, negotiating 304 and gzip. */
async function sendEntry(req, res, entry, { status = 200, cacheControl = 'no-cache' } = {}) {
  res.setHeader('etag', entry.etag);
  res.setHeader('cache-control', cacheControl);
  res.setHeader('vary', 'Accept-Encoding');
  if (req.headers['if-none-match'] === entry.etag) {
    res.statusCode = 304;
    return res.end();
  }
  res.setHeader('content-type', entry.type);
  let body = entry.raw;
  if (acceptsGzip(req) && entry.raw.length > 1024) {
    if (!entry.gz) entry.gz = gzip(entry.raw, { level: 6 });
    body = await entry.gz;
    res.setHeader('content-encoding', 'gzip');
  }
  res.statusCode = status;
  res.setHeader('content-length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function jsonEntry(data) {
  const raw = Buffer.from(JSON.stringify(data));
  return { raw, gz: null, etag: etagOf(raw), type: MIME['.json'] };
}

function sendJson(req, res, status, data) {
  const entry = jsonEntry(data);
  return sendEntry(req, res, entry, { status, cacheControl: 'no-store' });
}

/** TTL cache of rendered JSON responses (keyed by URL). */
class ResponseCache {
  constructor() {
    this.map = new Map();
  }
  clear() {
    this.map.clear();
  }
  async get(key, ttlMs, produce) {
    const hit = this.map.get(key);
    if (hit && hit.exp > Date.now()) return hit.entry;
    if (hit && hit.pending) return hit.pending;
    const pending = (async () => {
      const data = await produce();
      const entry = jsonEntry(data);
      this.map.set(key, { exp: Date.now() + ttlMs, entry });
      return entry;
    })();
    this.map.set(key, { exp: 0, pending, entry: hit?.entry });
    try {
      return await pending;
    } catch (e) {
      this.map.delete(key);
      throw e;
    }
  }
}

/** Fixed-window per-IP rate limiter (best effort; behind a proxy the first X-Forwarded-For hop is used). */
class RateLimiter {
  constructor(limit, windowMs = 60000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    }, windowMs);
    this.timer.unref();
  }
  static ip(req) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return xff || req.socket.remoteAddress || 'unknown';
  }
  check(req) {
    if (!this.limit) return { ok: true };
    const key = RateLimiter.ip(req);
    const now = Date.now();
    let h = this.hits.get(key);
    if (!h || h.reset <= now) {
      h = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, h);
    }
    h.count++;
    return { ok: h.count <= this.limit, retryAfter: Math.ceil((h.reset - now) / 1000) };
  }
}

/** Serves files from `root`, with ETag revalidation and gzip. */
function createStaticServer(root) {
  const base = path.resolve(root);
  const cache = new Map(); // file -> {mtimeMs, entry}

  return async function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return false;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(base, `.${path.posix.normalize(`/${rel}`)}`);
    if (file !== base && !file.startsWith(base + path.sep)) return false;

    let st;
    try {
      st = await fs.promises.stat(file);
    } catch {
      return false;
    }
    if (!st.isFile()) return false;

    let hit = cache.get(file);
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
      const raw = await fs.promises.readFile(file);
      hit = {
        mtimeMs: st.mtimeMs,
        entry: { raw, gz: null, etag: etagOf(raw), type: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' },
      };
      cache.set(file, hit);
    }
    await sendEntry(req, res, hit.entry, { cacheControl: 'no-cache' });
    return true;
  };
}

module.exports = { MIME, applySecurityHeaders, sendEntry, sendJson, jsonEntry, ResponseCache, RateLimiter, createStaticServer };
