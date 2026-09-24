'use strict';

/**
 * Minimal PostgREST client (what Supabase exposes at /rest/v1) built on fetch, so the app needs
 * no npm dependencies. Only the features Tra5x uses: select with filters/order/paging/count,
 * insert/upsert, update and rpc.
 */
class PostgrestError extends Error {
  constructor(status, body, ctx) {
    const msg = body && typeof body === 'object' ? body.message || JSON.stringify(body) : String(body || '');
    super(`Supabase ${ctx} failed (HTTP ${status}): ${msg}`);
    this.status = status;
    this.body = body;
  }
}

class PostgrestClient {
  constructor(baseUrl, key, { timeoutMs = 60000 } = {}) {
    if (!baseUrl || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    this.base = `${baseUrl.replace(/\/+$/, '')}/rest/v1`;
    this.key = key;
    this.timeoutMs = timeoutMs;
  }

  headers(extra = {}) {
    const h = { apikey: this.key, accept: 'application/json', ...extra };
    // Legacy service_role keys are JWTs and go in Authorization too; new sb_secret_ keys only in apikey.
    if (this.key.startsWith('eyJ')) h.authorization = `Bearer ${this.key}`;
    return h;
  }

  async request(method, path, { params, body, prefer, timeoutMs, ctx } = {}) {
    const url = new URL(`${this.base}/${path}`);
    if (params) for (const [k, v] of params) url.searchParams.append(k, v);
    const headers = this.headers();
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (prefer) headers.prefer = prefer;

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || this.timeoutMs),
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) throw new PostgrestError(res.status, data, ctx || `${method} ${path}`);
    return { data, headers: res.headers };
  }

  /**
   * @param {string} table
   * @param {{select?:string, filters?:Array<[string,string,any]>, order?:string, limit?:number, offset?:number, count?:boolean}} q
   * filters are [column, operator, value] with PostgREST operators (eq, gt, lt, gte, lte, in, ilike, is, not.is ...).
   */
  async select(table, q = {}) {
    const params = [['select', q.select || '*']];
    for (const [col, op, val] of q.filters || []) {
      if (col === 'or') {
        // ['or', '', 'player_id.eq.5,from_player_id.eq.5'] -> or=(player_id.eq.5,from_player_id.eq.5)
        params.push(['or', `(${val})`]);
        continue;
      }
      const v = op === 'in' ? `(${val.join(',')})` : val;
      params.push([col, `${op}.${v}`]);
    }
    if (q.order) params.push(['order', q.order]);
    if (q.limit != null) params.push(['limit', String(q.limit)]);
    if (q.offset) params.push(['offset', String(q.offset)]);
    const { data, headers } = await this.request('GET', table, {
      params,
      prefer: q.count ? 'count=exact' : undefined,
      ctx: `select ${table}`,
    });
    if (!q.count) return { rows: data || [], total: null };
    const range = headers.get('content-range') || '';
    const total = Number(range.split('/')[1]);
    return { rows: data || [], total: Number.isFinite(total) ? total : null };
  }

  /** Like select() but pages through the whole result (Supabase caps a response at max_rows, 1000 by default). */
  async selectAll(table, q = {}, { pageSize = 1000, maxPages = 50 } = {}) {
    const out = [];
    for (let page = 0; page < maxPages; page++) {
      const { rows } = await this.select(table, { ...q, limit: pageSize, offset: page * pageSize });
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  }

  async insert(table, rows, { returning = false, ctx } = {}) {
    const { data } = await this.request('POST', table, {
      body: rows,
      prefer: returning ? 'return=representation' : 'return=minimal',
      ctx: ctx || `insert ${table}`,
    });
    return data;
  }

  async upsert(table, rows, { onConflict, timeoutMs } = {}) {
    await this.request('POST', table, {
      params: onConflict ? [['on_conflict', onConflict]] : undefined,
      body: rows,
      prefer: 'resolution=merge-duplicates,return=minimal',
      timeoutMs,
      ctx: `upsert ${table}`,
    });
  }

  async update(table, patch, filters) {
    const params = filters.map(([col, op, val]) => [col, `${op}.${val}`]);
    await this.request('PATCH', table, { params, body: patch, prefer: 'return=minimal', ctx: `update ${table}` });
  }

  async rpc(fn, args, { timeoutMs } = {}) {
    const { data } = await this.request('POST', `rpc/${fn}`, { body: args, timeoutMs, ctx: `rpc ${fn}` });
    return data;
  }
}

module.exports = { PostgrestClient, PostgrestError };
