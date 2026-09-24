'use strict';

/**
 * Synthetic Travian world generator that emits files in the exact map.sql format
 * (`INSERT INTO `x_world` VALUES (...)`, 16 columns). Used by the tests and by `npm run demo`.
 * It is NOT real rog.x5 data.
 */

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRIBE_POOL = [1, 1, 2, 2, 3, 3, 3, 6, 7, 8, 9, 9];
const FIRST = ['Aria', 'Bram', 'Cato', 'Dara', 'Eryx', 'Fenn', 'Gala', 'Hugo', 'Ilse', 'Joss', 'Kira', 'Loki', 'Mira', 'Nero', 'Odin', 'Pia', 'Quin', 'Rurik', 'Sven', 'Tara', 'Ulf', 'Vera', 'Wren', 'Xan', 'Yara', 'Zed'];
const TAGS = ['NOVA', 'ORCA', 'IRON', 'VIKE', 'LEGN', 'GAUL', 'HUNS', 'ROME', 'ARES', 'ZULU', 'KING', 'WOLF', 'STAR', 'FIRE', 'DUSK', 'ECHO'];
const ODD_NAMES = ["O'Brien", 'Foo, Bar (2)', 'Ünïcode Ñandú', 'Back\\slash', 'Semi;colon', 'Quote"d'];

function createWorld({ seed = 1, radius = 100, players = 300, alliances = 12, regions = false } = {}) {
  const rand = rng(seed);
  const world = { seed, radius, regions, day: 0, rand, nextVillageId: 1000, players: [], alliances: [], occupied: new Map(), natars: [] };

  for (let i = 0; i < Math.min(alliances, TAGS.length); i++) world.alliances.push({ id: 100 + i, tag: TAGS[i] });

  const takeTile = () => {
    for (let tries = 0; tries < 1000; tries++) {
      const x = Math.round((rand() + rand() - 1) * radius);
      const y = Math.round((rand() + rand() - 1) * radius);
      const key = `${x},${y}`;
      if (!world.occupied.has(key)) {
        world.occupied.set(key, true);
        return { x, y };
      }
    }
    throw new Error('map full');
  };
  world.takeTile = takeTile;

  const addVillage = (p, capital = false) => {
    const t = takeTile();
    p.villages.push({ ...t, vid: world.nextVillageId++, name: `${p.name.split(/[ ,]/)[0]}'s ${capital ? 'Capital' : `Village ${p.villages.length + 1}`}`.replace(/'s /, ' '), pop: capital ? 150 + Math.floor(rand() * 400) : 40 + Math.floor(rand() * 250), capital });
  };
  world.addVillage = addVillage;

  for (let i = 0; i < players; i++) {
    const base = i < ODD_NAMES.length ? ODD_NAMES[i] : `${FIRST[i % FIRST.length]}${Math.floor(i / FIRST.length) || ''}`;
    const p = {
      id: 2 + i,
      name: base,
      tribe: TRIBE_POOL[Math.floor(rand() * TRIBE_POOL.length)],
      alliance: rand() < 0.78 && world.alliances.length ? world.alliances[Math.floor(rand() * rand() * world.alliances.length)] : null,
      villages: [],
      joinedDay: 0,
      leftDay: null,
      growth: 0.005 + rand() * 0.03,
    };
    const n = 1 + Math.floor(-Math.log(1 - rand()) * 1.4);
    addVillage(p, true);
    for (let v = 1; v < Math.min(n, 12); v++) addVillage(p);
    world.players.push(p);
  }

  // Natars: player id 1, tribe 5
  for (let i = 0; i < 40; i++) {
    const t = takeTile();
    world.natars.push({ ...t, vid: world.nextVillageId++, pop: 200 + Math.floor(rand() * 300) });
  }
  return world;
}

/** Simulates one game day: growth, new villages, newcomers and a few departures. */
function advance(world) {
  const { rand } = world;
  world.day++;
  for (const p of world.players) {
    if (p.leftDay !== null) continue;
    for (const v of p.villages) v.pop = Math.round(v.pop * (1 + p.growth * (0.5 + rand())) + 1 + rand() * 6);
    if (rand() < 0.04 && p.villages.length < 12) world.addVillage(p);
    if (rand() < 0.01) {
      p.leftDay = world.day;
      for (const v of p.villages) world.occupied.delete(`${v.x},${v.y}`);
    }
  }
  const newcomers = Math.floor(rand() * 4);
  for (let i = 0; i < newcomers; i++) {
    const p = {
      id: 2 + world.players.length,
      name: `New${world.day}_${i}`,
      tribe: TRIBE_POOL[Math.floor(rand() * TRIBE_POOL.length)],
      alliance: null,
      villages: [],
      joinedDay: world.day,
      leftDay: null,
      growth: 0.01 + rand() * 0.03,
    };
    world.addVillage(p, true);
    world.players.push(p);
  }

  const active = () => world.players.filter((p) => p.leftDay === null);

  // Conquests: a non-capital village changes owner (same tile, same village id).
  const conquests = Math.floor(rand() * 4);
  for (let i = 0; i < conquests; i++) {
    const pool = active();
    const attacker = pool[Math.floor(rand() * pool.length)];
    const victim = pool[Math.floor(rand() * pool.length)];
    if (!attacker || !victim || attacker === victim || attacker.villages.length >= 12) continue;
    const idx = victim.villages.findIndex((v) => !v.capital);
    if (idx === -1) continue;
    attacker.villages.push(victim.villages.splice(idx, 1)[0]);
  }

  // Alliance moves: someone joins, leaves or switches alliance.
  const moves = Math.floor(rand() * 3);
  for (let i = 0; i < moves && world.alliances.length; i++) {
    const pool = active();
    const p = pool[Math.floor(rand() * pool.length)];
    if (!p) continue;
    const options = [null, ...world.alliances].filter((a) => a !== p.alliance);
    p.alliance = options[Math.floor(rand() * options.length)];
  }
}

const q = (s) => (s === null || s === undefined ? 'NULL' : `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, rngStyle(s))}'`);
// MySQL dumps escape a quote either as \' or ''. Alternate on string length to exercise both.
function rngStyle(s) {
  return String(s).length % 2 ? "\\'" : "''";
}

function toRows(world) {
  const rows = [];
  let id = 1;
  const region = (x, y) => (world.regions ? (y >= 0 ? (x >= 0 ? 'Northeast' : 'Northwest') : x >= 0 ? 'Southeast' : 'Southwest') : null);
  for (const p of world.players) {
    if (p.leftDay !== null) continue;
    for (const v of p.villages) {
      rows.push([id++, v.x, v.y, p.tribe, v.vid, v.name, p.id, p.name, p.alliance ? p.alliance.id : 0, p.alliance ? p.alliance.tag : '', v.pop, region(v.x, v.y), v.capital, false, false, null]);
    }
  }
  for (const v of world.natars) rows.push([id++, v.x, v.y, 5, v.vid, 'Natar Village', 1, 'Natars', 0, '', v.pop, region(v.x, v.y), false, false, false, null]);
  // a few unoccupied tiles (oasis-like rows) to make sure they are ignored
  for (let i = 0; i < 25; i++) rows.push([id++, -world.radius + i, world.radius, 4, null, null, null, null, null, null, 0, null, null, null, null, null]);
  return rows;
}

const lit = (v) => (v === null || v === undefined ? 'NULL' : v === true ? 'TRUE' : v === false ? 'FALSE' : typeof v === 'string' ? q(v) : String(v));

/** @param {{multi?: number}} opts multi > 0 groups that many tuples per INSERT statement */
function toMapSql(world, { multi = 0 } = {}) {
  const rows = toRows(world);
  const tuple = (r) => {
    const t = r.map((v, i) => (i === 5 || i === 7 || i === 9 || i === 11 ? (v === null ? 'NULL' : q(v)) : lit(v)));
    return `(${t.join(',')})`;
  };
  const out = [];
  if (multi > 0) {
    for (let i = 0; i < rows.length; i += multi) out.push(`INSERT INTO \`x_world\` VALUES ${rows.slice(i, i + multi).map(tuple).join(',\n')};`);
  } else {
    for (const r of rows) out.push(`INSERT INTO \`x_world\` VALUES ${tuple(r)};`);
  }
  return `${out.join('\n')}\n`;
}

module.exports = { createWorld, advance, toMapSql, toRows };
