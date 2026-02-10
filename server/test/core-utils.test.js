import test from "node:test";
import assert from "node:assert/strict";

import { STANDARD_ARRAY, STAT_KEYS } from "../mcp/constants.js";
import {
  buildStartingStats,
  clamp,
  normalizeStats,
  normalizeStoryElements,
  parseDiceFormula,
  rollDice,
  slugifyId,
} from "../mcp/core-utils.js";

test("clamp constrains value to range", () => {
  assert.equal(clamp(7, 1, 5), 5);
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(4, 0, 10), 4);
});

test("normalizeStats resolves invalid values from fallback and clamps", () => {
  const normalized = normalizeStats(
    {
      str: 99,
      agi: "bad",
      con: -5,
    },
    {
      str: 2,
      agi: 14,
      con: 12,
      int: 11,
      wis: 10,
      cha: 9,
    }
  );

  assert.deepEqual(Object.keys(normalized).sort(), [...STAT_KEYS].sort());
  assert.equal(normalized.str, 20);
  assert.equal(normalized.agi, 14);
  assert.equal(normalized.con, 1);
  assert.equal(normalized.int, 11);
  assert.equal(normalized.wis, 10);
  assert.equal(normalized.cha, 9);
});

test("buildStartingStats returns a shuffled standard array", () => {
  const stats = buildStartingStats();
  const values = Object.values(stats).sort((a, b) => a - b);

  assert.deepEqual(values, [...STANDARD_ARRAY].sort((a, b) => a - b));
});

test("buildStartingStats applies stat focus boost", () => {
  const stats = buildStartingStats("int");

  assert.equal(stats.int, 16);
  assert.equal(Object.values(stats).reduce((sum, value) => sum + value, 0), 73);
});

test("parseDiceFormula parses valid formulas and rejects invalid ones", () => {
  assert.deepEqual(parseDiceFormula(" 2d6 + 3 "), {
    count: 2,
    sides: 6,
    modifier: 3,
    cleaned: "2d6+3",
  });

  assert.equal(parseDiceFormula("2d1"), null);
  assert.equal(parseDiceFormula("xd6"), null);
  assert.equal(parseDiceFormula(""), null);
});

test("rollDice returns totals that match component rolls", () => {
  const result = rollDice("3d4-2");
  assert.ok(result);

  assert.equal(result.formula, "3d4-2");
  assert.equal(result.rolls.length, 3);
  result.rolls.forEach((roll) => {
    assert.ok(roll >= 1 && roll <= 4);
  });
  assert.equal(result.total, result.rolls.reduce((sum, value) => sum + value, 0) - 2);
});

test("normalizeStoryElements supports arrays and comma-separated strings", () => {
  assert.deepEqual(normalizeStoryElements(["A", "", "B"]), ["A", "B"]);
  assert.deepEqual(normalizeStoryElements("A,  B , ,C"), ["A", "B", "C"]);
  assert.deepEqual(normalizeStoryElements(null), []);
});

test("slugifyId normalizes values safely", () => {
  assert.equal(slugifyId("  Arcane Blade++ "), "arcane_blade");
  assert.equal(slugifyId("___"), "entry");
  assert.equal(slugifyId("", "fallback"), "fallback");
});
