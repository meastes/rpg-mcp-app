import crypto from "node:crypto";
import { DEFAULT_MELEE_RANGE, MAX_LEVEL, MAX_RANGE } from "./constants.js";
import { clamp, slugifyId } from "./core-utils.js";

export function normalizeWeapon(raw, fallbackName, fallbackIdPrefix = "weapon") {
  if (!raw) return null;
  const category = raw.category === "ranged" ? "ranged" : "melee";
  const defaultRange = category === "melee" ? DEFAULT_MELEE_RANGE : 6;
  const rawRange = Number(raw.range ?? defaultRange);
  const range = clamp(
    Number.isFinite(rawRange) ? rawRange : defaultRange,
    category === "melee" ? DEFAULT_MELEE_RANGE : 1,
    MAX_RANGE
  );
  const fallbackId = `${fallbackIdPrefix}_${slugifyId(fallbackName, "weapon")}`;
  return {
    id: raw.id ?? fallbackId,
    name: raw.name ?? fallbackName ?? "Weapon",
    category,
    range,
    equipped: Boolean(raw.equipped),
    damageFormula: raw.damageFormula ?? "",
  };
}

export function normalizeSkill(raw, fallbackName, fallbackIdPrefix = "skill") {
  if (!raw) return null;
  const fallbackId = `${fallbackIdPrefix}_${slugifyId(fallbackName, "skill")}`;
  return {
    id: raw.id ?? fallbackId,
    name: raw.name ?? fallbackName ?? "Skill",
    unlockLevel: clamp(Number(raw.unlockLevel ?? 1), 1, MAX_LEVEL),
    mpCost: clamp(Number(raw.mpCost ?? 0), 0, 99),
    range: clamp(Number(raw.range ?? DEFAULT_MELEE_RANGE), 0, MAX_RANGE),
    target: raw.target === "self" || raw.target === "ally" ? raw.target : "enemy",
    description: raw.description ?? "",
  };
}

export function normalizeInventoryItem(item) {
  if (!item?.name) return null;
  const normalized = {
    id: item.id ?? `item_${crypto.randomUUID()}`,
    name: item.name,
    qty: clamp(Number(item.qty ?? 1), 1, 999),
    notes: item.notes ?? "",
  };
  const normalizedWeapon = normalizeWeapon(item.weapon, item.name, "weapon");
  if (normalizedWeapon) {
    normalized.weapon = normalizedWeapon;
  }
  return normalized;
}

export function getSkillCatalog(level, existing = []) {
  const known = new Map();
  if (Array.isArray(existing)) {
    existing.forEach((skill) => {
      const normalized = normalizeSkill(skill, skill?.name, "skill");
      if (normalized) known.set(normalized.id, normalized);
    });
  }
  const allSkills = [...known.values()].sort(
    (a, b) => a.unlockLevel - b.unlockLevel || a.name.localeCompare(b.name)
  );
  const safeLevel = clamp(Number(level ?? 1), 1, MAX_LEVEL);
  return {
    allSkills,
    unlockedSkills: allSkills.filter((skill) => skill.unlockLevel <= safeLevel),
  };
}

export function getInventoryWeapons(inventory = []) {
  if (!Array.isArray(inventory)) return [];
  const weapons = inventory
    .filter((item) => item?.weapon && Number(item.qty ?? 0) > 0)
    .map((item) => normalizeWeapon(item.weapon, item.name, "weapon"))
    .filter(Boolean);
  return weapons;
}

export function ensureSingleEquippedWeapon(weapons = [], preferredWeaponId) {
  if (!Array.isArray(weapons) || weapons.length === 0) return [];
  const preferred =
    preferredWeaponId && weapons.some((weapon) => weapon.id === preferredWeaponId)
      ? preferredWeaponId
      : null;
  const firstEquipped = weapons.find((weapon) => weapon.equipped)?.id ?? null;
  const selectedId = preferred ?? firstEquipped ?? weapons[0].id;
  return weapons.map((weapon) => ({
    ...weapon,
    equipped: weapon.id === selectedId,
  }));
}

export function syncInventoryWeaponEquipFlags(inventory = [], preferredWeaponId) {
  if (!Array.isArray(inventory)) return;
  const normalizedWeapons = inventory
    .filter((item) => item?.weapon)
    .map((item) => ({
      item,
      weapon: normalizeWeapon(item.weapon, item.name, "weapon"),
    }))
    .filter((entry) => entry.weapon);
  if (normalizedWeapons.length === 0) return;
  const normalized = ensureSingleEquippedWeapon(
    normalizedWeapons.map((entry) => entry.weapon),
    preferredWeaponId
  );
  normalized.forEach((weapon, index) => {
    normalizedWeapons[index].item.weapon = weapon;
  });
}

export function applyInventoryDelta(game, delta) {
  if (!delta) return;
  const { add, remove } = delta;
  if (Array.isArray(add)) {
    add.forEach((item) => {
      if (!item?.name) return;
      const qty = clamp(Number(item.qty ?? 1), 1, 999);
      const existing = game.inventory.find(
        (entry) => entry.name.toLowerCase() === item.name.toLowerCase()
      );
      if (existing) {
        existing.qty = clamp(existing.qty + qty, 0, 999);
        if (item.notes) existing.notes = item.notes;
        const normalizedWeapon = normalizeWeapon(item.weapon, item.name, "weapon");
        if (normalizedWeapon) existing.weapon = normalizedWeapon;
      } else {
        const normalized = normalizeInventoryItem(item);
        if (!normalized) return;
        game.inventory.push(normalized);
      }
    });
  }

  if (Array.isArray(remove)) {
    remove.forEach((removal) => {
      if (!removal?.id) return;
      const idx = game.inventory.findIndex((entry) => entry.id === removal.id);
      if (idx === -1) return;
      const qty = clamp(Number(removal.qty ?? 1), 1, 999);
      game.inventory[idx].qty = clamp(game.inventory[idx].qty - qty, 0, 999);
      if (game.inventory[idx].qty <= 0) {
        game.inventory.splice(idx, 1);
      }
    });
  }
  syncInventoryWeaponEquipFlags(game.inventory);
}
