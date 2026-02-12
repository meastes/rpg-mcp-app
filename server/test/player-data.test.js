import test from "node:test";
import assert from "node:assert/strict";

import {
  applyInventoryDelta,
  ensureSingleEquippedWeapon,
  getInventoryWeapons,
  getSkillCatalog,
  normalizeInventoryItem,
  normalizeSkill,
  normalizeWeapon,
  syncInventoryWeaponEquipFlags,
} from "../mcp/player-data.js";

test("normalizeWeapon defaults and clamps ranges", () => {
  const melee = normalizeWeapon({ category: "melee", range: 99 }, "Sword");
  assert.equal(melee.range, 30);
  const meleeMin = normalizeWeapon({ category: "melee", range: 0 }, "Dagger");
  assert.equal(meleeMin.range, 1);

  const ranged = normalizeWeapon({ category: "ranged", range: 999 }, "Bow");
  assert.equal(ranged.range, 30);

  const fallback = normalizeWeapon({}, "Arcane Blade");
  assert.equal(fallback.id, "weapon_arcane_blade");
  assert.equal(fallback.name, "Arcane Blade");
});

test("normalizeSkill coerces defaults and bounds", () => {
  const skill = normalizeSkill(
    {
      unlockLevel: 999,
      mpCost: -5,
      range: 999,
      target: "unsupported",
    },
    "Burst"
  );

  assert.equal(skill.id, "skill_burst");
  assert.equal(skill.unlockLevel, 20);
  assert.equal(skill.mpCost, 0);
  assert.equal(skill.range, 30);
  assert.equal(skill.target, "enemy");
});

test("normalizeInventoryItem creates a stable item shape", () => {
  const item = normalizeInventoryItem({
    name: "Rope",
    qty: 2,
    notes: "50ft",
    weapon: { category: "melee", equipped: true },
  });

  assert.ok(item.id.startsWith("item_"));
  assert.equal(item.qty, 2);
  assert.equal(item.weapon.name, "Rope");
});

test("getSkillCatalog sorts and filters unlocked skills", () => {
  const catalog = getSkillCatalog(3, [
    { id: "s3", name: "Third", unlockLevel: 3 },
    { id: "s1", name: "First", unlockLevel: 1 },
    { id: "s2", name: "Second", unlockLevel: 5 },
  ]);

  assert.deepEqual(
    catalog.allSkills.map((s) => s.id),
    ["s1", "s3", "s2"]
  );
  assert.deepEqual(
    catalog.unlockedSkills.map((s) => s.id),
    ["s1", "s3"]
  );
});

test("ensureSingleEquippedWeapon prefers requested equipped id", () => {
  const weapons = ensureSingleEquippedWeapon(
    [
      { id: "w1", equipped: true },
      { id: "w2", equipped: true },
      { id: "w3", equipped: false },
    ],
    "w3"
  );

  assert.equal(weapons.filter((w) => w.equipped).length, 1);
  assert.equal(weapons.find((w) => w.equipped).id, "w3");
});

test("syncInventoryWeaponEquipFlags keeps only one equipped weapon", () => {
  const inventory = [
    {
      id: "item_sword",
      name: "Sword",
      qty: 1,
      weapon: { id: "w_sword", category: "melee", equipped: true },
    },
    {
      id: "item_bow",
      name: "Bow",
      qty: 1,
      weapon: { id: "w_bow", category: "ranged", range: 6, equipped: true },
    },
  ];

  syncInventoryWeaponEquipFlags(inventory, "w_bow");

  const equipped = inventory.filter((item) => item.weapon?.equipped);
  assert.equal(equipped.length, 1);
  assert.equal(equipped[0].weapon.id, "w_bow");
});

test("getInventoryWeapons returns weaponized inventory only", () => {
  const weapons = getInventoryWeapons([
    { id: "a", name: "Sword", qty: 1, weapon: { id: "w1", category: "melee", equipped: true } },
    { id: "b", name: "Potion", qty: 3 },
    { id: "c", name: "Broken bow", qty: 0, weapon: { id: "w2", category: "ranged", range: 5 } },
  ]);

  assert.equal(weapons.length, 1);
  assert.equal(weapons[0].id, "w1");
});

test("applyInventoryDelta merges, removes, and syncs equipment flags", () => {
  const game = {
    inventory: [
      {
        id: "item_sword",
        name: "Sword",
        qty: 1,
        notes: "old",
        weapon: { id: "w_sword", category: "melee", equipped: true },
      },
    ],
  };

  applyInventoryDelta(game, {
    add: [
      { name: "Sword", qty: 2, notes: "sharpened" },
      {
        name: "Bow",
        qty: 1,
        weapon: { id: "w_bow", category: "ranged", range: 8, equipped: true },
      },
    ],
  });

  const sword = game.inventory.find((item) => item.name === "Sword");
  const bow = game.inventory.find((item) => item.name === "Bow");

  assert.equal(sword.qty, 3);
  assert.equal(sword.notes, "sharpened");
  assert.ok(bow);
  assert.equal(
    game.inventory.filter((item) => item.weapon?.equipped).length,
    1
  );

  applyInventoryDelta(game, {
    remove: [{ id: sword.id, qty: 3 }],
  });

  assert.equal(game.inventory.some((item) => item.name === "Sword"), false);
  assert.equal(game.inventory.some((item) => item.name === "Bow"), true);
});
