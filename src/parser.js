'use strict';

/**
 * Parser for Travian's public map.sql export.
 *
 * Official column order of table `x_world` (16 columns; unsupported ones are NULL on older worlds):
 *   0 id, 1 x, 2 y, 3 tribe, 4 village id, 5 village name, 6 player id, 7 player name,
 *   8 alliance id, 9 alliance tag, 10 population, 11 region, 12 capital, 13 city, 14 harbor, 15 victory points
 *
 * The parser is a small hand-written tokenizer (no regex over values) that tolerates
 * multi-row INSERTs, quoted strings with '' or \' escapes, commas/parentheses inside names,
 * NULL / TRUE / FALSE literals and rows with fewer than 16 columns.
 */

const CH_SPACE = 32, CH_LF = 10, CH_CR = 13, CH_TAB = 9, CH_COMMA = 44;
const CH_LPAREN = 40, CH_RPAREN = 41, CH_SEMI = 59, CH_QUOTE = 39, CH_BSLASH = 92;

const ESCAPES = { n: '\n', r: '\r', t: '\t', 0: '\0', b: '\b', Z: '\x1a' };

function token(raw) {
  const t = raw.trim();
  if (t === '') return null;
  const u = t.toUpperCase();
  if (u === 'NULL') return null;
  if (u === 'TRUE') return true;
  if (u === 'FALSE') return false;
  const n = Number(t);
  return Number.isNaN(n) ? t : n;
}

/** Parses one "(...)" tuple; `i` points just after the opening parenthesis. Returns [values, nextIndex] or null. */
function parseTuple(text, i) {
  const n = text.length;
  const vals = [];
  for (;;) {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR) i++;
      else break;
    }
    if (i >= n) return null;

    if (text.charCodeAt(i) === CH_QUOTE) {
      let s = '';
      i++;
      let start = i;
      for (;;) {
        if (i >= n) return null; // unterminated string
        const ch = text.charCodeAt(i);
        if (ch === CH_BSLASH) {
          const next = text[i + 1];
          s += text.slice(start, i) + (ESCAPES[next] ?? next ?? '');
          i += 2;
          start = i;
        } else if (ch === CH_QUOTE) {
          if (text.charCodeAt(i + 1) === CH_QUOTE) {
            s += text.slice(start, i) + "'";
            i += 2;
            start = i;
          } else {
            s += text.slice(start, i);
            i++;
            break;
          }
        } else {
          i++;
        }
      }
      vals.push(s);
    } else {
      const start = i;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === CH_COMMA || c === CH_RPAREN) break;
        i++;
      }
      if (i >= n) return null;
      vals.push(token(text.slice(start, i)));
    }

    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR) i++;
      else break;
    }
    const d = text.charCodeAt(i);
    if (d === CH_COMMA) {
      i++;
      continue;
    }
    if (d === CH_RPAREN) return [vals, i + 1];
    return null; // malformed
  }
}

/** Yields raw value arrays for every tuple of every `INSERT INTO x_world ... VALUES` statement. */
function* iterateTuples(text, stats) {
  const n = text.length;
  const re = /(?:INSERT|REPLACE)\s+(?:IGNORE\s+)?INTO\s+`?x_world`?\s*(?:\([^)]*\)\s*)?VALUES/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let i = re.lastIndex;
    for (;;) {
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR || c === CH_COMMA) i++;
        else break;
      }
      if (i >= n) break;
      const c = text.charCodeAt(i);
      if (c === CH_SEMI) {
        i++;
        break;
      }
      if (c !== CH_LPAREN) break; // something unexpected: resume scanning at the next INSERT
      const res = parseTuple(text, i + 1);
      if (!res) {
        stats.skipped++;
        const next = text.indexOf('),(', i);
        if (next === -1) break;
        i = next + 2;
        continue;
      }
      i = res[1];
      yield res[0];
    }
    re.lastIndex = Math.max(i, re.lastIndex);
  }
}

const asBool = (v) => (v == null ? null : v === true || v === 1 || /^(true|1|yes)$/i.test(String(v)));
const asInt = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

function toRow(v) {
  if (v.length < 11) return null;
  const x = asInt(v[1]);
  const y = asInt(v[2]);
  if (x === null || y === null) return null;
  return {
    id: asInt(v[0]),
    x,
    y,
    tribe: asInt(v[3]),
    villageId: asInt(v[4]),
    village: v[5] == null ? null : String(v[5]),
    playerId: asInt(v[6]),
    player: v[7] == null ? null : String(v[7]),
    allianceId: asInt(v[8]),
    alliance: v[9] == null ? null : String(v[9]),
    population: asInt(v[10]) ?? 0,
    region: v[11] == null ? null : String(v[11]),
    capital: asBool(v[12]),
    city: asBool(v[13]),
    harbor: asBool(v[14]),
    victoryPoints: asInt(v[15]),
  };
}

/** Streams parsed rows without materialising them all (keeps memory low for large worlds). */
function* iterateRows(text, stats = { tuples: 0, skipped: 0 }) {
  for (const vals of iterateTuples(text, stats)) {
    stats.tuples++;
    const row = toRow(vals);
    if (row) yield row;
    else stats.skipped++;
  }
}

/**
 * @param {string} text contents of map.sql
 * @returns {{rows: object[], tuples: number, skipped: number}}
 */
function parseMapSql(text) {
  const stats = { tuples: 0, skipped: 0 };
  const rows = [...iterateRows(text, stats)];
  return { rows, tuples: stats.tuples, skipped: stats.skipped };
}

module.exports = { parseMapSql, iterateRows, parseTuple };
