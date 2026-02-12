import test from "node:test";
import assert from "node:assert/strict";

import { createCombatSystem } from "../mcp/combat-system.js";

function createGame({ inventory = [], skills = [], hp = 12, mp = 6 } = {}) {
  return {
    gameId: "game_test",
    phase: "exploration",
    setupComplete: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    genre: "Adventure",
    tone: "Cinematic",
    storyElements: [],
    pc: {
      name: "Hero",
      pronouns: "",
      archetype: "",
      background: "",
      goal: "",
      level: 1,
      skills,
    },
    stats: { str: 10, agi: 10, con: 10, int: 10, wis: 10, cha: 10 },
    hp: { current: hp, max: hp },
    mp: { current: mp, max: mp },
    inventory,
    location: "Test Arena",
    combat: null,
    lastRoll: null,
    log: [],
  };
}

function createSwordInventory() {
  return [
    {
      id: "item_sword",
      name: "Sword",
      qty: 1,
      weapon: {
        id: "w_sword",
        name: "Sword",
        category: "melee",
        range: 1,
        equipped: true,
        damageFormula: "",
      },
    },
  ];
}

function createCombatSystemForTest() {
  return createCombatSystem({
    addLog(game, entry, kind = "system") {
      game.log.push({
        id: `log_${game.log.length + 1}`,
        kind,
        text: entry,
      });
    },
  });
}

function startCombat(system, game, { enemyPosition = 1, enemyHp = 6 } = {}) {
  const pcId = `pc_${game.gameId}`;
  const enemyId = "enemy_1";

  system.applyCombatUpdate(game, {
    active: true,
    round: 1,
    currentTurnId: pcId,
    pc: {
      position: 0,
      speed: 6,
      movementRemaining: 6,
    },
    enemies: [
      {
        id: enemyId,
        name: "Goblin",
        hp: enemyHp,
        hpMax: enemyHp,
        position: enemyPosition,
        speed: 6,
        movementRemaining: 6,
        weapons: [
          {
            id: "w_club",
            name: "Club",
            category: "melee",
            equipped: true,
            damageFormula: "",
          },
        ],
      },
    ],
    initiative: [
      { id: pcId, name: "Hero", kind: "pc", initiative: 20 },
      { id: enemyId, name: "Goblin", kind: "enemy", initiative: 10 },
    ],
  });

  return { pcId, enemyId };
}

test("applyCombatUpdate(active=true) initializes combat and turn state", () => {
  const system = createCombatSystemForTest();
  const game = createGame({ inventory: createSwordInventory() });
  const { pcId } = startCombat(system, game);

  assert.equal(game.phase, "combat");
  assert.ok(game.combat);
  assert.equal(game.combat.currentTurnId, pcId);
  assert.equal(game.combat.turn.actorId, pcId);
});

test("syncCombatState equips unarmed weapon when inventory has no weapons", () => {
  const system = createCombatSystemForTest();
  const game = createGame({ inventory: [] });
  startCombat(system, game);

  system.syncCombatState(game);

  assert.ok(game.combat.pc.weapons.some((weapon) => weapon.id === "weapon_unarmed"));
});

test("resolveCombatAction blocks ending turn before an action", () => {
  const system = createCombatSystemForTest();
  const game = createGame({ inventory: createSwordInventory() });
  startCombat(system, game);

  const result = system.resolveCombatAction(game, {
    gameId: game.gameId,
    action: "end_turn",
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /cannot end before using one action/i);
});

test("resolveCombatAction enforces movement remaining", () => {
  const system = createCombatSystemForTest();
  const game = createGame({ inventory: createSwordInventory() });
  startCombat(system, game);
  game.combat.pc.movementRemaining = 1;

  const result = system.resolveCombatAction(game, {
    gameId: game.gameId,
    action: "move",
    moveBy: 2,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /movement remaining/i);
});

test("resolveCombatAction rejects attacks with an unequipped/unknown weapon", () => {
  const system = createCombatSystemForTest();
  const game = createGame({ inventory: createSwordInventory() });
  const { enemyId } = startCombat(system, game);

  const result = system.resolveCombatAction(game, {
    gameId: game.gameId,
    action: "attack",
    targetId: enemyId,
    weaponId: "missing_weapon",
    damage: 1,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /must use an equipped weapon/i);
});

test("resolveCombatAction rejects out-of-range attacks", () => {
  const system = createCombatSystemForTest();
  const game = createGame({ inventory: createSwordInventory() });
  const { enemyId } = startCombat(system, game, { enemyPosition: 8 });

  const result = system.resolveCombatAction(game, {
    gameId: game.gameId,
    action: "attack",
    targetId: enemyId,
    damage: 1,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /out of range/i);
});

test("resolveCombatAction attack can end combat in victory", () => {
  const system = createCombatSystemForTest();
  const game = createGame({ inventory: createSwordInventory() });
  const { enemyId } = startCombat(system, game, { enemyPosition: 1, enemyHp: 4 });

  const result = system.resolveCombatAction(game, {
    gameId: game.gameId,
    action: "attack",
    targetId: enemyId,
    damage: 4,
  });

  assert.equal(result.ok, true);
  assert.match(result.message, /victory/i);
  assert.equal(game.combat, null);
  assert.equal(game.phase, "exploration");
});

test("resolveCombatAction validates MP for skills", () => {
  const system = createCombatSystemForTest();
  const game = createGame({
    inventory: createSwordInventory(),
    mp: 0,
    skills: [
      {
        id: "skill_fire",
        name: "Fire",
        unlockLevel: 1,
        mpCost: 5,
        range: 6,
        target: "enemy",
      },
    ],
  });
  const { enemyId } = startCombat(system, game, { enemyPosition: 1 });

  const result = system.resolveCombatAction(game, {
    gameId: game.gameId,
    action: "use_skill",
    skillId: "skill_fire",
    targetId: enemyId,
    damage: 2,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /not have enough MP/i);
});

test("applyCombatUpdate(active=false) exits combat and logs the change", () => {
  const system = createCombatSystemForTest();
  const game = createGame({ inventory: createSwordInventory() });
  startCombat(system, game);

  system.applyCombatUpdate(game, { active: false });

  assert.equal(game.combat, null);
  assert.equal(game.phase, "exploration");
  assert.ok(game.log.some((entry) => /combat ended/i.test(entry.text)));
});
