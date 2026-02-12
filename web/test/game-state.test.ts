import test from "node:test";
import assert from "node:assert/strict";

import {
  buildEnemies,
  buildInitiative,
  buildStats,
  clamp,
  formatStatModifier,
  formatStatValue,
  getGameMode,
  normalizeEnemySeverity,
} from "../src/lib/game-state.ts";

const baseState = {
  type: "ttrpg_state" as const,
  gameId: "game_test",
  phase: "exploration",
  setupComplete: true,
  pc: { name: "Hero" },
  stats: { str: 15, agi: 14, con: 13, int: 12, wis: 10, cha: 8 },
  hp: { current: 10, max: 12 },
  mp: { current: 4, max: 6 },
  inventory: [],
  location: "Arena",
  combat: null,
  lastRoll: null,
  log: [],
};

test("clamp enforces numeric bounds", () => {
  assert.equal(clamp(8, 1, 5), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(7, 0, 10), 7);
});

test("format helpers return placeholders and signed values", () => {
  assert.equal(formatStatValue(undefined), "--");
  assert.equal(formatStatValue(12), 12);
  assert.equal(formatStatModifier(undefined), "--");
  assert.equal(formatStatModifier(2), "+2");
  assert.equal(formatStatModifier(-1), "-1");
});

test("normalizeEnemySeverity prefers explicit valid status", () => {
  assert.equal(normalizeEnemySeverity("Critical", 999, 999), "Critical");
});

test("normalizeEnemySeverity derives status from hp ratio", () => {
  assert.equal(normalizeEnemySeverity(undefined, 0, 10), "Down");
  assert.equal(normalizeEnemySeverity(undefined, 1, 10), "Critical");
  assert.equal(normalizeEnemySeverity(undefined, 5, 10), "Wounded");
  assert.equal(normalizeEnemySeverity(undefined, 9, 10), "Unhurt");
});

test("buildStats maps AGI to DEX and preserves values", () => {
  const stats = buildStats(baseState);
  assert.deepEqual(stats, {
    STR: 15,
    DEX: 14,
    CON: 13,
    INT: 12,
    WIS: 10,
    CHA: 8,
  });
});

test("buildEnemies normalizes ids, severity, and note fallback", () => {
  const enemies = buildEnemies({
    ...baseState,
    combat: {
      enemies: [
        {
          name: "Goblin",
          hp: 2,
          hpMax: 10,
          intent: "Flank",
        },
      ],
    },
  });

  assert.equal(enemies.length, 1);
  assert.equal(enemies[0].id, "enemy_Goblin");
  assert.equal(enemies[0].severity, "Badly Wounded");
  assert.equal(enemies[0].note, "Flank");
});

test("buildInitiative sorts descending and defaults kind to pc", () => {
  const initiative = buildInitiative({
    ...baseState,
    combat: {
      initiative: [
        { id: "e1", name: "Enemy", kind: "enemy", initiative: 11 },
        { id: "p1", name: "Hero", initiative: 15 },
      ],
    },
  });

  assert.deepEqual(
    initiative.map((entry) => ({ id: entry.id, kind: entry.kind, initiative: entry.initiative })),
    [
      { id: "p1", kind: "pc", initiative: 15 },
      { id: "e1", kind: "enemy", initiative: 11 },
    ]
  );
});

test("getGameMode returns combat when phase or combat payload indicates it", () => {
  assert.equal(getGameMode(baseState), "explore");
  assert.equal(getGameMode({ ...baseState, phase: "combat" }), "combat");
  assert.equal(getGameMode({ ...baseState, combat: { round: 1 } }), "combat");
});
