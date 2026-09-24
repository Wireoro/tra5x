'use strict';
const { createWorld, advance, toMapSql } = require('./fixture');

const silent = { log() {}, warn() {}, error() {} };

function testConfig(over = {}) {
  return {
    world: 'test.example.com',
    mapUrl: 'https://test.example.com/map.sql',
    mapFile: '',
    userAgent: 'test',
    historyTopPlayers: 0,
    retentionDays: 0,
    maxVillageEvents: 30000,
    mapRadius: 0,
    mapWrap: true,
    dbSizeLimitMb: 500,
    autoRefresh: true,
    refreshAfterHours: 20,
    pollMinutes: 60,
    retryMinutes: 15,
    adminToken: '',
    rateLimitPerMin: 0,
    port: 0,
    ...over,
  };
}

/** A fake downloader that serves whatever `state.buffer` holds. */
function fakeFetcher(state) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (state.error) throw new Error(state.error);
    if (state.notModified) return { notModified: true };
    return { buffer: Buffer.from(state.text), etag: state.etag || null, lastModified: state.lastModified || null, contentType: state.contentType || 'text/plain', finalUrl: url };
  };
  fn.calls = calls;
  return fn;
}

module.exports = { createWorld, advance, toMapSql, silent, testConfig, fakeFetcher };
