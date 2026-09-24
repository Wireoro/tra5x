'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMapSql } = require('../src/parser');
const { createWorld, toMapSql } = require('../scripts/fixture');

test('parses the official 16-column format', () => {
  const sql = "INSERT INTO `x_world` VALUES (1,-200,200,3,4711,'Nice Village',12,'Alice',7,'ABC',345,NULL,TRUE,FALSE,FALSE,NULL);\n" +
    "INSERT INTO `x_world` VALUES (2,5,-6,2,4712,'Second',13,'Bob',0,'',80,'Region 1',FALSE,FALSE,TRUE,12);\n";
  const { rows, tuples, skipped } = parseMapSql(sql);
  assert.equal(tuples, 2);
  assert.equal(skipped, 0);
  assert.deepEqual(rows[0], {
    id: 1, x: -200, y: 200, tribe: 3, villageId: 4711, village: 'Nice Village', playerId: 12, player: 'Alice',
    allianceId: 7, alliance: 'ABC', population: 345, region: null, capital: true, city: false, harbor: false, victoryPoints: null,
  });
  assert.equal(rows[1].region, 'Region 1');
  assert.equal(rows[1].harbor, true);
  assert.equal(rows[1].victoryPoints, 12);
  assert.equal(rows[1].y, -6);
});

test('handles multi-row inserts, escapes, commas and parentheses inside strings', () => {
  const sql = "INSERT INTO `x_world` VALUES (1,0,0,1,1,'It\\'s, (odd)',2,'O''Brien',3,'A;B',10,NULL,FALSE,FALSE,FALSE,NULL),\n" +
    "(2,1,1,1,2,'Back\\\\slash',3,'Ünï',0,'',11,NULL,FALSE,FALSE,FALSE,NULL);\n";
  const { rows } = parseMapSql(sql);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].village, "It's, (odd)");
  assert.equal(rows[0].player, "O'Brien");
  assert.equal(rows[0].alliance, 'A;B');
  assert.equal(rows[1].village, 'Back\\slash');
  assert.equal(rows[1].player, 'Ünï');
});

test('accepts older worlds with only 11 columns and skips malformed tuples', () => {
  const sql = "INSERT INTO `x_world` VALUES (1,1,2,1,9,'V',5,'P',0,'',33);\n" +
    "INSERT INTO `x_world` VALUES (2,3,'broken\n" +
    "INSERT INTO `x_world` VALUES (3,4,5,2,10,'W',6,'Q',0,'',44);\n";
  const { rows, skipped } = parseMapSql(sql);
  assert.deepEqual(rows.map((r) => r.id), [1, 3]);
  assert.equal(rows[0].region, null);
  assert.equal(rows[0].capital, null);
  assert.ok(skipped >= 1);
});

test('round-trips a generated world in single and multi-row layouts', () => {
  const world = createWorld({ seed: 7, players: 120, alliances: 6 });
  const a = parseMapSql(toMapSql(world));
  const b = parseMapSql(toMapSql(world, { multi: 50 }));
  assert.ok(a.rows.length > 200);
  assert.equal(a.skipped, 0);
  assert.deepEqual(b.rows, a.rows);
  assert.ok(a.rows.some((r) => r.player === "O'Brien"));
  assert.ok(a.rows.some((r) => r.player === 'Foo, Bar (2)'));
  assert.ok(a.rows.some((r) => r.player === 'Back\\slash'));
});

test('returns nothing (no throw) for garbage or HTML input', () => {
  assert.equal(parseMapSql('<html>maintenance</html>').rows.length, 0);
  assert.equal(parseMapSql('').rows.length, 0);
});
