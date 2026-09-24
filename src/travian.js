'use strict';

const zlib = require('node:zlib');

/** Tribe ids used by map.sql (official Travian documentation). */
const TRIBES = {
  1: 'Romans',
  2: 'Teutons',
  3: 'Gauls',
  4: 'Nature',
  5: 'Natars',
  6: 'Egyptians',
  7: 'Huns',
  8: 'Spartans',
  9: 'Vikings',
};
const NATAR_TRIBE = 5;

/**
 * Downloads map.sql. Handles plain text, Content-Encoding (done by fetch) and raw .gz bodies.
 * Uses a conditional GET when the previous ETag / Last-Modified are known.
 */
async function fetchMapSql(url, opts = {}) {
  const { etag, lastModified, userAgent, timeoutMs = 120000, maxBytes = 300 * 1024 * 1024 } = opts;
  const headers = {
    'user-agent': userAgent || 'Tra5x/1.0',
    accept: 'text/plain, application/sql, application/octet-stream;q=0.9, */*;q=0.5',
    'accept-encoding': 'gzip, deflate, br',
  };
  if (etag) headers['if-none-match'] = etag;
  else if (lastModified) headers['if-modified-since'] = new Date(lastModified).toUTCString();

  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 304) return { notModified: true };
  if (!res.ok) throw new Error(`map.sql request failed: HTTP ${res.status} ${res.statusText}`.trim());

  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) throw new Error(`map.sql is too large (${declared} bytes)`);

  let buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`map.sql is too large (${buffer.length} bytes)`);
  if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) buffer = zlib.gunzipSync(buffer);

  const lm = res.headers.get('last-modified');
  return {
    buffer,
    etag: res.headers.get('etag') || null,
    lastModified: lm && !Number.isNaN(Date.parse(lm)) ? new Date(lm).toISOString() : null,
    contentType: res.headers.get('content-type') || '',
    finalUrl: res.url || url,
  };
}

module.exports = { TRIBES, NATAR_TRIBE, fetchMapSql };
