import { z } from "zod";
import { MAX_LEVEL, MAX_RANGE } from "./constants.js";

export const weaponInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  category: z.enum(["melee", "ranged"]).optional(),
  range: z.number().int().min(1).max(MAX_RANGE).optional(),
  equipped: z.boolean().optional(),
  damageFormula: z.string().optional(),
});

export const skillInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  unlockLevel: z.number().int().min(1).max(MAX_LEVEL).optional(),
  mpCost: z.number().int().min(0).max(99).optional(),
  range: z.number().int().min(0).max(MAX_RANGE).optional(),
  target: z.enum(["enemy", "ally", "self"]).optional(),
  description: z.string().optional(),
});

export const inventoryItemInputSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  qty: z.number().int().optional(),
  notes: z.string().optional(),
  weapon: weaponInputSchema.optional(),
});

export const setupPreferencesSchema = z.object({
  gameId: z.string().optional(),
  genre: z.string().optional(),
  tone: z.string().optional(),
  storyElements: z.union([z.array(z.string()), z.string()]).optional(),
  startingLocation: z.string().optional(),
  startingInventory: z.array(inventoryItemInputSchema).optional(),
  hpMax: z.number().int().min(1).max(999).optional(),
  mpMax: z.number().int().min(0).max(999).optional(),
  startingHp: z.number().int().min(0).max(999).optional(),
  startingMp: z.number().int().min(0).max(999).optional(),
  statFocus: z.enum(["str", "agi", "con", "int", "wis", "cha"]).optional(),
  stats: z
    .object({
      str: z.number().int().min(1).max(20),
      agi: z.number().int().min(1).max(20),
      con: z.number().int().min(1).max(20),
      int: z.number().int().min(1).max(20),
      wis: z.number().int().min(1).max(20),
      cha: z.number().int().min(1).max(20),
    })
    .optional(),
  pc: z
    .object({
      name: z.string().optional(),
      pronouns: z.string().optional(),
      archetype: z.string().optional(),
      background: z.string().optional(),
      goal: z.string().optional(),
      level: z.number().int().min(1).max(MAX_LEVEL).optional(),
      skills: z.array(skillInputSchema).optional(),
    })
    .optional(),
});

export const beginSetupSchema = setupPreferencesSchema;

export const confirmSetupSchema = setupPreferencesSchema
  .omit({ gameId: true })
  .extend({
    setupId: z.string(),
  });

export const startGameSchema = setupPreferencesSchema.extend({
  setupId: z.string().optional(),
});

export const newSessionSchema = setupPreferencesSchema.extend({
  mode: z.enum(["auto", "guided"]).optional(),
});

export const getStateSchema = z.object({
  gameId: z.string(),
});

export const rollDiceSchema = z.object({
  gameId: z.string(),
  formula: z.string(),
  reason: z.string().optional(),
});

export const updateStateSchema = z.object({
  gameId: z.string(),
  hpDelta: z.number().int().optional(),
  mpDelta: z.number().int().optional(),
  hp: z.number().int().optional(),
  mp: z.number().int().optional(),
  location: z.string().optional(),
  skills: z.array(skillInputSchema).optional(),
  pc: z
    .object({
      name: z.string().optional(),
      pronouns: z.string().optional(),
      archetype: z.string().optional(),
      background: z.string().optional(),
      goal: z.string().optional(),
      level: z.number().int().min(1).max(MAX_LEVEL).optional(),
      skills: z.array(skillInputSchema).optional(),
    })
    .optional(),
  inventory: z
    .object({
      add: z.array(inventoryItemInputSchema).optional(),
      remove: z
        .array(
          z.object({
            id: z.string(),
            qty: z.number().int().optional(),
          })
        )
        .optional(),
      equipWeaponId: z.string().optional(),
    })
    .optional(),
  combat: z
    .object({
      active: z.boolean(),
      round: z.number().int().optional(),
      currentTurnId: z.string().optional(),
      pcHp: z.number().int().optional(),
      pcHpDelta: z.number().int().optional(),
      pcMp: z.number().int().optional(),
      pcMpDelta: z.number().int().optional(),
      enemyName: z.string().optional(),
      enemyHp: z.number().int().optional(),
      enemyHpMax: z.number().int().optional(),
      enemyIntent: z.string().optional(),
      pc: z
        .object({
          id: z.string().optional(),
          level: z.number().int().min(1).max(MAX_LEVEL).optional(),
          position: z.number().int().min(0).max(100).optional(),
          speed: z.number().int().min(0).max(MAX_RANGE).optional(),
          movementRemaining: z.number().int().min(0).max(MAX_RANGE).optional(),
          actionUsed: z.boolean().optional(),
          defending: z.boolean().optional(),
          dodging: z.boolean().optional(),
          equippedWeaponId: z.string().optional(),
          hp: z.number().int().min(0).max(999).optional(),
          hpMax: z.number().int().min(1).max(999).optional(),
          mp: z.number().int().min(0).max(999).optional(),
          mpMax: z.number().int().min(0).max(999).optional(),
          weapons: z.array(weaponInputSchema).optional(),
          skills: z.array(skillInputSchema).optional(),
        })
        .optional(),
      enemies: z
        .array(
          z.object({
            id: z.string().optional(),
            name: z.string(),
            hp: z.number().int().optional(),
            hpMax: z.number().int().optional(),
            status: z.string().optional(),
            intent: z.string().optional(),
            note: z.string().optional(),
            mp: z.number().int().min(0).max(999).optional(),
            mpMax: z.number().int().min(0).max(999).optional(),
            level: z.number().int().min(1).max(MAX_LEVEL).optional(),
            position: z.number().int().min(0).max(100).optional(),
            speed: z.number().int().min(0).max(MAX_RANGE).optional(),
            movementRemaining: z.number().int().min(0).max(MAX_RANGE).optional(),
            actionUsed: z.boolean().optional(),
            defending: z.boolean().optional(),
            dodging: z.boolean().optional(),
            equippedWeaponId: z.string().optional(),
            weapons: z.array(weaponInputSchema).optional(),
            skills: z.array(skillInputSchema).optional(),
          })
        )
        .optional(),
      initiative: z
        .array(
          z.object({
            id: z.string().optional(),
            name: z.string(),
            kind: z.enum(["pc", "enemy"]).optional(),
            initiative: z.number().int().optional(),
          })
        )
        .optional(),
    })
    .optional(),
  logEntry: z.string().optional(),
  logKind: z.string().optional(),
});

export const combatActionSchema = z.object({
  gameId: z.string(),
  actorId: z.string().optional(),
  action: z.enum(["attack", "defend", "dodge", "use_skill", "move", "end_turn"]),
  targetId: z.string().optional(),
  weaponId: z.string().optional(),
  skillId: z.string().optional(),
  damage: z.number().int().min(0).optional(),
  heal: z.number().int().min(0).optional(),
  moveBy: z.number().int().optional(),
  moveTo: z.number().int().min(0).max(100).optional(),
});

export const resetGameSchema = z.object({
  gameId: z.string(),
});
