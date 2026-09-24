'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PostgrestClient, PostgrestError } = require('../src/store/postgrest');
const { SupabaseStore } = require('../src/store/supabase');

/** Tiny fake PostgREST that records requests and answers from a handler. */
async function fake(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const rec = { method: req.method, path: url.pathname, params: [...url.searchParams], headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined };
      seen.push(rec);
      const out = handler(rec) || { status: 200, body: [] };
      res.writeHead(out.status || 200, { 'content-type': 'application/json', ...(out.headers || {}) });
      res.end(out.body === undefined ? '' : JSON.stringify(out.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('select builds PostgREST filters, ordering, paging and reads the exact count', async () => {
  const f = await fake(() => ({ headers: { 'content-range': '0-49/1234' }, body: [{ id: 1 }] }));
  try {
    const db = new PostgrestClient(f.url, 'sb_secret_abc');
    const { rows, total } = await db.select('players', { select: 'id,name', filters: [['world', 'eq', 'w'], ['id', 'in', [1, 2, 3]], ['name', 'ilike', '*bob*']], order: 'rank.asc.nullslast,id.asc', limit: 50, offset: 100, count: true });
    assert.deepEqual(rows, [{ id: 1 }]);
    assert.equal(total, 1234);
    const r = f.seen[0];
    assert.equal(r.path, '/rest/v1/players');
    assert.deepEqual(Object.fromEntries(r.params), { select: 'id,name', world: 'eq.w', id: 'in.(1,2,3)', name: 'ilike.*bob*', order: 'rank.asc.nullslast,id.asc', limit: '50', offset: '100' });
    assert.equal(r.headers.prefer, 'count=exact');
    assert.equal(r.headers.apikey, 'sb_secret_abc');
    assert.equal(r.headers.authorization, undefined); // new-style secret keys are not JWTs
  } finally {
    await f.close();
  }
});

test('legacy JWT service keys are also sent as a bearer token', async () => {
  const f = await fake(() => ({ body: [] }));
  try {
    await new PostgrestClient(f.url, 'eyJhbGciOi.payload.sig').select('snapshots');
    assert.equal(f.seen[0].headers.authorization, 'Bearer eyJhbGciOi.payload.sig');
  } finally {
    await f.close();
  }
});

test('selectAll pages through max-rows limited responses', async () => {
  const f = await fake((r) => {
    const found = r.params.find(([k]) => k === 'offset');
    const off = found ? Number(found[1]) : 0;
    const rows = off === 0 ? Array.from({ length: 1000 }, (_, i) => ({ i })) : off === 1000 ? Array.from({ length: 200 }, (_, i) => ({ i: 1000 + i })) : [];
    return { body: rows };
  });
  try {
    const all = await new PostgrestClient(f.url, 'k').selectAll('tribe_stats', { order: 'snapshot_id.asc' });
    assert.equal(all.length, 1200);
    assert.equal(f.seen.length, 2);
  } finally {
    await f.close();
  }
});

test('errors surface the PostgREST message and status', async () => {
  const f = await fake(() => ({ status: 401, body: { code: '42501', message: 'permission denied for table players' } }));
  try {
    await assert.rejects(new PostgrestClient(f.url, 'k').select('players'), (e) => e instanceof PostgrestError && e.status === 401 && /permission denied/.test(e.message));
  } finally {
    await f.close();
  }
});

test('SupabaseStore.ingest calls the RPC with {p: payload} and upserts the map cache', async () => {
  const f = await fake((r) => (r.path.endsWith('/rpc/ingest_snapshot') ? { body: 42 } : { status: 201 }));
  try {
    const store = new SupabaseStore({ url: f.url, key: 'k' });
    const payload = { world: 'w.example', content_hash: 'abc', players: [{ id: 1 }] };
    const id = await store.ingest(payload, { ver: 1, count: 0 });
    assert.equal(id, 42);
    assert.equal(f.seen[0].method, 'POST');
    assert.equal(f.seen[0].path, '/rest/v1/rpc/ingest_snapshot');
    assert.deepEqual(f.seen[0].body, { p: payload });
    const up = f.seen[1];
    assert.equal(up.path, '/rest/v1/map_cache');
    assert.deepEqual(Object.fromEntries(up.params), { on_conflict: 'world' });
    assert.equal(up.headers.prefer, 'resolution=merge-duplicates,return=minimal');
    assert.equal(up.body.world, 'w.example');
    assert.equal(up.body.snapshot_id, 42);
  } finally {
    await f.close();
  }
});

test('player search input cannot inject PostgREST filter syntax', async () => {
  const f = await fake(() => ({ headers: { 'content-range': '0-0/0' }, body: [] }));
  try {
    const store = new SupabaseStore({ url: f.url, key: 'k' });
    await store.listPlayers('w', { q: 'a,b)(c%_\\', sort: 'drop table', dir: 'sideways', limit: 5, offset: 0 });
    const p = Object.fromEntries(f.seen[0].params);
    assert.equal(p.name, 'ilike.*a b  c **');
    assert.equal(p.order, 'rank.asc.nullslast,id.asc'); // unknown sort column falls back to rank
  } finally {
    await f.close();
  }
});
