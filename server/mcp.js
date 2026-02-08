import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isPersistenceEnabled,
  loadGameState,
  saveGameState,
} from "./persistence.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const widgetPath = path.join(process.cwd(), "web/dist/widget.html");

const TOOL_OUTPUT_TEMPLATE = "ui://widget/rpg.html";
const commonToolMeta = {
  "openai/outputTemplate": TOOL_OUTPUT_TEMPLATE,
};
const GAME_GUIDE_RESOURCE = "rpg://guide";
const SETUP_SESSION_TTL_MS = 30 * 60 * 1000;
const BASE_REQUIRED_SETUP_CHOICES = [
  "genre",
  "pc.name",
  "pc.archetype",
  "startingLocation",
];
const GUIDED_ONLY_REQUIRED_SETUP_CHOICES = ["stats"];
const GAME_GUIDE_SUMMARY =
  "Read the guide, pick genre/tone, starting location, and core character details, then confirm setup before starting.";
const DEFAULT_GENRES = [
  "Adventure",
  "Mystery",
  "Science Fiction",
];
const DEFAULT_TONES = ["Cinematic", "Grounded", "Gritty"];
const DEFAULT_ARCHETYPES = ["Specialist", "Guardian", "Scout", "Scholar", "Wildcard"];
const DEFAULT_PC_NAMES = ["Rowan", "Kestrel", "Iris", "Thorn", "Ash"];
const DEFAULT_STARTING_LOCATIONS = [
  "The Rusted Causeway",
  "Old Harbor Market",
  "Sunken Observatory",
  "Ashwind Rail Yard",
  "Glass Dunes Outpost",
];
const GAME_GUIDE_TEXT = `TTRPG Game Guide (general, system-agnostic)

Core loop:
- Present a scene and a clear choice.
- Ask for intent and approach.
- Resolve with a roll when failure is interesting or time matters.
- Describe the outcome and update state.

Running a session:
- Start with a hook, a goal, and a constraint.
- Track stakes: what happens on success, partial, or failure.
- Keep the pace by alternating spotlight between players.
- Use short, concrete descriptions; ask questions to fill in details.

Encounters:
- Make enemies intelligible: name, intent, and a tell.
- Use the environment (cover, hazards, objectives) to vary tactics.
- End fights when the story shifts: surrender, retreat, or twist.

Stats & leveling (D&D 5e style, not enforced):
- Starting stats: standard array 15,14,13,12,10,8 or 27-point buy (8-15 pre-bonuses).
- Primary stat: aim for 14-16 after ancestry/background bonuses.
- Ability increases at levels 4,8,12,16,19: +2 one stat or +1/+1, max 20.
- Optional: proficiency bonus +2 at level 1; +3 at 5; +4 at 9; +5 at 13; +6 at 17.

Rewards and progression:
- Reward what you want to see: risk, creativity, teamwork.
- Give tangible progress: clues, allies, reputation, or gear.

Safety and consent:
- Confirm boundaries; allow players to skip content without explanation.
- Keep a quick stop/slow/swap option available.

Remember: these are guidelines. Adjust to fit your table.`;

const games = new Map();
const setupSessions = new Map();

const STAT_KEYS = Object.freeze(["str", "agi", "con", "int", "wis", "cha"]);
const STANDARD_ARRAY = Object.freeze([15, 14, 13, 12, 10, 8]);
const baseStats = Object.freeze({
  str: 15,
  agi: 14,
  con: 13,
  int: 12,
  wis: 10,
  cha: 8,
});
const DEFAULT_MELEE_RANGE = 1;
const DEFAULT_MOVE_SPEED = 6;
const MAX_RANGE = 30;
const MAX_LEVEL = 20;
const COMBAT_ACTIONS_REQUIRING_ACTION = new Set([
  "attack",
  "defend",
  "dodge",
  "use_skill",
]);
const UNARMED_WEAPON_ID = "weapon_unarmed";
const UNARMED_WEAPON = Object.freeze({
  id: UNARMED_WEAPON_ID,
  name: "Default Melee",
  category: "melee",
  range: DEFAULT_MELEE_RANGE,
  equipped: true,
  damageFormula: "1",
});
const DEFAULT_ENEMY_WEAPON = Object.freeze({
  id: "weapon_enemy_basic",
  name: "Basic Weapon",
  category: "melee",
  range: DEFAULT_MELEE_RANGE,
  equipped: true,
  damageFormula: "1d6",
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeStats(rawStats = {}, fallbackStats = baseStats) {
  const normalized = {};
  STAT_KEYS.forEach((key) => {
    const rawValue = Number(rawStats?.[key]);
    const fallbackValue = Number(fallbackStats?.[key]);
    const resolved = Number.isFinite(rawValue)
      ? rawValue
      : Number.isFinite(fallbackValue)
        ? fallbackValue
        : 10;
    normalized[key] = clamp(resolved, 1, 20);
  });
  return normalized;
}

function buildStartingStats(statFocus) {
  const values = [...STANDARD_ARRAY];
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(0, index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }

  const randomized = {};
  STAT_KEYS.forEach((key, index) => {
    randomized[key] = values[index] ?? baseStats[key];
  });

  if (!statFocus || !Object.prototype.hasOwnProperty.call(randomized, statFocus)) {
    return randomized;
  }

  const highestKey = STAT_KEYS.reduce(
    (bestKey, key) => (randomized[key] > randomized[bestKey] ? key : bestKey),
    STAT_KEYS[0]
  );
  if (highestKey !== statFocus) {
    [randomized[highestKey], randomized[statFocus]] = [
      randomized[statFocus],
      randomized[highestKey],
    ];
  }
  return withStatFocus(randomized, statFocus);
}

function nowIso() {
  return new Date().toISOString();
}

function purgeExpiredSetupSessions() {
  const now = Date.now();
  for (const [setupId, entry] of setupSessions.entries()) {
    if (!entry || entry.expiresAt <= now) {
      setupSessions.delete(setupId);
    }
  }
}

function mergeSetupArgs(base = {}, patch = {}) {
  return {
    ...base,
    ...patch,
    pc: {
      ...(base.pc ?? {}),
      ...(patch.pc ?? {}),
    },
  };
}

function isCompleteStatsObject(stats) {
  if (!stats || typeof stats !== "object") return false;
  return STAT_KEYS.every((key) => Number.isFinite(Number(stats[key])));
}

function isGuideAlignedStartingStats(stats) {
  if (!isCompleteStatsObject(stats)) return false;
  const values = STAT_KEYS.map((key) => Number(stats[key]));
  return values.every((value) => Number.isInteger(value) && value >= 8 && value <= 15);
}

function getRequiredSetupChoices(mode = "guided") {
  return mode === "guided"
    ? [...BASE_REQUIRED_SETUP_CHOICES, ...GUIDED_ONLY_REQUIRED_SETUP_CHOICES]
    : [...BASE_REQUIRED_SETUP_CHOICES];
}

function pickRandom(list, fallback) {
  if (!Array.isArray(list) || list.length === 0) return fallback;
  const index = crypto.randomInt(0, list.length);
  return list[index];
}

function applySetupDefaults(args = {}) {
  const merged = mergeSetupArgs({}, args);
  if (!merged.genre) merged.genre = pickRandom(DEFAULT_GENRES, "Adventure");
  if (!merged.tone) merged.tone = pickRandom(DEFAULT_TONES, "Cinematic");
  if (!merged.startingLocation) {
    merged.startingLocation = pickRandom(
      DEFAULT_STARTING_LOCATIONS,
      "Old Harbor Market"
    );
  }
  merged.pc = merged.pc ?? {};
  if (!merged.pc.name) merged.pc.name = pickRandom(DEFAULT_PC_NAMES, "Traveler");
  if (!merged.pc.archetype) {
    merged.pc.archetype = pickRandom(DEFAULT_ARCHETYPES, "Specialist");
  }
  return merged;
}

function missingSetupChoices(args = {}, mode = "guided") {
  const missing = [];
  if (!args.genre) missing.push("genre");
  if (!args.pc?.name) missing.push("pc.name");
  if (!args.pc?.archetype) missing.push("pc.archetype");
  if (!String(args.startingLocation ?? "").trim()) {
    missing.push("startingLocation");
  }
  if (mode === "guided" && !isCompleteStatsObject(args.stats)) {
    missing.push("stats");
  }
  return missing;
}

function invalidSetupChoices(args = {}, mode = "guided") {
  const invalid = [];
  if (
    mode === "guided" &&
    isCompleteStatsObject(args.stats) &&
    !isGuideAlignedStartingStats(args.stats)
  ) {
    invalid.push("stats");
  }
  return invalid;
}

function beginSetupSession(gameId, startArgs = {}, mode = "guided") {
  purgeExpiredSetupSessions();
  const setupId = `setup_${crypto.randomUUID()}`;
  const resolvedMode = mode === "auto" ? "auto" : "guided";
  setupSessions.set(setupId, {
    setupId,
    gameId,
    mode: resolvedMode,
    issuedAt: Date.now(),
    expiresAt: Date.now() + SETUP_SESSION_TTL_MS,
    confirmed: false,
    startArgs: startArgs ?? {},
  });
  return setupSessions.get(setupId);
}

function getSetupSession(setupId) {
  purgeExpiredSetupSessions();
  if (!setupId) return null;
  return setupSessions.get(setupId) ?? null;
}

function confirmSetupSession(setupId, patchArgs = {}) {
  const session = getSetupSession(setupId);
  if (!session) {
    return {
      ok: false,
      message:
        "Setup session not found or expired. Call begin_setup to start again.",
    };
  }

  session.startArgs = mergeSetupArgs(session.startArgs, patchArgs);
  const missing = missingSetupChoices(session.startArgs, session.mode);
  const invalid = invalidSetupChoices(session.startArgs, session.mode);
  if (missing.length > 0 || invalid.length > 0) {
    const messageParts = [];
    if (missing.length > 0) messageParts.push(`missing ${missing.join(", ")}`);
    if (invalid.length > 0) {
      messageParts.push(
        `invalid ${invalid.join(", ")} (guided stats must be integers in the 8-15 range)`
      );
    }
    return {
      ok: false,
      message: `Setup still needs ${messageParts.join("; ")}.`,
      missingChoices: missing,
      invalidChoices: invalid,
      session,
    };
  }

  session.confirmed = true;
  session.confirmedAt = Date.now();
  return { ok: true, session };
}

function consumeConfirmedSetupSession(setupId, requestedGameId) {
  const session = getSetupSession(setupId);
  if (!session) {
    return {
      ok: false,
      message:
        "Setup session not found or expired. Call begin_setup and confirm_setup again.",
    };
  }

  if (requestedGameId && session.gameId !== requestedGameId) {
    return {
      ok: false,
      message: "setupId does not match gameId. Use the gameId returned by begin_setup.",
    };
  }

  if (!session.confirmed) {
    return {
      ok: false,
      message: "Setup is not confirmed. Call confirm_setup before start_game.",
    };
  }

  setupSessions.delete(setupId);
  return {
    ok: true,
    gameId: session.gameId,
    mode: session.mode,
    startArgs: session.startArgs,
  };
}

function createGameState(overrides = {}) {
  const id = overrides.gameId ?? `game_${crypto.randomUUID()}`;
  const hpMax = overrides.hpMax ?? 12;
  const mpMax = overrides.mpMax ?? 6;

  return {
    gameId: id,
    phase: "setup",
    setupComplete: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    genre: overrides.genre ?? "",
    tone: overrides.tone ?? "",
    storyElements: overrides.storyElements ?? [],
    pc: {
      name: overrides.pc?.name ?? "",
      pronouns: overrides.pc?.pronouns ?? "",
      archetype: overrides.pc?.archetype ?? "",
      background: overrides.pc?.background ?? "",
      goal: overrides.pc?.goal ?? "",
      level: clamp(Number(overrides.pc?.level ?? 1), 1, MAX_LEVEL),
      skills: Array.isArray(overrides.pc?.skills)
        ? overrides.pc.skills
            .map((skill) => normalizeSkill(skill, skill?.name, "skill"))
            .filter(Boolean)
        : [],
    },
    stats: normalizeStats(overrides.stats ?? buildStartingStats(overrides.statFocus)),
    hp: { current: hpMax, max: hpMax },
    mp: { current: mpMax, max: mpMax },
    inventory: overrides.inventory ?? [],
    location: overrides.location ?? "",
    combat: null,
    lastRoll: null,
    log: [],
  };
}

function withStatFocus(stats, focus) {
  if (!focus || !Object.prototype.hasOwnProperty.call(stats, focus)) {
    return stats;
  }

  return { ...stats, [focus]: clamp(stats[focus] + 1, 1, 20) };
}

async function getGame(gameId) {
  if (!gameId) return null;
  const cached = games.get(gameId);
  if (cached) return cached;
  const persisted = await loadGameState(gameId);
  if (!persisted) return null;
  games.set(gameId, persisted);
  return persisted;
}

async function persistGame(game) {
  game.updatedAt = nowIso();
  games.set(game.gameId, game);
  if (isPersistenceEnabled()) {
    const result = await saveGameState(game);
    if (!result.ok) {
      console.error("Failed to persist game state to Supabase.");
    }
  }
  return game;
}

function sanitizeImageTheme(rawTheme) {
  const sanitized = String(rawTheme ?? "")
    .replace(
      /\b(tabletop|ttrpg|rpg|mmorpg|jrpg|video\s*game|videogame|gameplay|hud|ui|screenshot)\b/gi,
      ""
    )
    .replace(/[,:;]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return sanitized || "Adventure";
}

function buildLocationImageRequest(game, trigger = "location_change") {
  const location = String(game?.location ?? "").trim() || "Unknown location";
  const theme = sanitizeImageTheme(game?.genre);
  const tone = String(game?.tone ?? "").trim() || "Cinematic";
  const storyHints = normalizeStoryElements(game?.storyElements).slice(0, 3);
  const hintText = storyHints.length
    ? ` Include subtle environmental hints of ${storyHints.join(", ")}.`
    : "";
  return {
    type: "location_image_request",
    gameId: game?.gameId ?? "",
    trigger,
    location,
    prompt:
      `Atmospheric environmental illustration. Theme: ${theme}. Tone: ${tone.toLowerCase()}. ` +
      `Establishing wide shot of ${location}. ` +
      "2D illustrated scene, cinematic but understated, high detail, rich atmosphere and believable lighting. " +
      "No foreground characters, no title text, no logos, no typography, no poster composition, no watermark. " +
      "No UI, no HUD, not a video game screenshot, not a 3D game render. " +
      hintText,
    requestedAt: nowIso(),
  };
}

function buildLocationImageInstructionText(imageRequest) {
  if (!imageRequest) return "";
  return (
    "Prompt-only mode: provide one polished image prompt for an external image generator and do not claim an image was generated here. " +
    `Location: ${imageRequest.location}. ` +
    `Prompt seed: ${imageRequest.prompt}`
  );
}

function summarizeState(game, { imageRequest } = {}) {
  const base = {
    type: "ttrpg_state",
    gameId: game.gameId,
    phase: game.phase,
    setupComplete: game.setupComplete,
    genre: game.genre,
    tone: game.tone,
    storyElements: game.storyElements,
    pc: game.pc,
    stats: normalizeStats(game.stats),
    hp: game.hp,
    mp: game.mp,
    inventory: game.inventory,
    location: game.location,
    combat: game.combat,
    lastRoll: game.lastRoll,
    log: game.log.slice(-12),
    updatedAt: game.updatedAt,
  };
  if (imageRequest) {
    base.imageRequest = imageRequest;
  }
  return base;
}

function replyWithState(game, message, { imageRequest } = {}) {
  const content = [];
  if (message) {
    content.push({ type: "text", text: message });
  }
  if (imageRequest) {
    content.push({
      type: "text",
      text: buildLocationImageInstructionText(imageRequest),
    });
  }
  return {
    content,
    structuredContent: summarizeState(game, { imageRequest }),
  };
}

function replyWithError(message) {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { type: "ttrpg_error", message },
  };
}

function parseDiceFormula(formula) {
  if (!formula || typeof formula !== "string") return null;
  const cleaned = formula.replace(/\s+/g, "").toLowerCase();
  const match = cleaned.match(/^(\d*)d(\d+)([+-]\d+)?$/);
  if (!match) return null;
  const count = Number(match[1] || 1);
  const sides = Number(match[2]);
  const modifier = Number(match[3] || 0);
  if (!Number.isFinite(count) || !Number.isFinite(sides) || count < 1 || sides < 2) {
    return null;
  }
  return { count, sides, modifier, cleaned };
}

function rollDice(formula) {
  const parsed = parseDiceFormula(formula);
  if (!parsed) return null;
  const rolls = Array.from({ length: parsed.count }, () =>
    crypto.randomInt(1, parsed.sides + 1)
  );
  const total = rolls.reduce((sum, value) => sum + value, 0) + parsed.modifier;
  return {
    formula: parsed.cleaned,
    rolls,
    modifier: parsed.modifier,
    total,
  };
}

function addLog(game, entry, kind = "system") {
  if (!entry) return;
  game.log.push({
    id: `log_${crypto.randomUUID()}`,
    at: nowIso(),
    kind,
    text: entry,
  });
}

function normalizeStoryElements(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function slugifyId(value, fallback = "entry") {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || fallback;
}

function normalizeWeapon(raw, fallbackName, fallbackIdPrefix = "weapon") {
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

function normalizeSkill(raw, fallbackName, fallbackIdPrefix = "skill") {
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

function normalizeInventoryItem(item) {
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

function getSkillCatalog(level, existing = []) {
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

function getInventoryWeapons(inventory = []) {
  if (!Array.isArray(inventory)) return [];
  const weapons = inventory
    .filter((item) => item?.weapon && Number(item.qty ?? 0) > 0)
    .map((item) => normalizeWeapon(item.weapon, item.name, "weapon"))
    .filter(Boolean);
  return weapons;
}

function ensureSingleEquippedWeapon(weapons = [], preferredWeaponId) {
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

function syncInventoryWeaponEquipFlags(inventory = [], preferredWeaponId) {
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

function applyInventoryDelta(game, delta) {
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

function getEnemyStatus(hp, hpMax) {
  const safeMax = Number.isFinite(hpMax) && hpMax > 0 ? hpMax : 0;
  const safeHp = Number.isFinite(hp) ? hp : 0;
  if (!safeMax) return "Unhurt";
  const pct = (safeHp / safeMax) * 100;
  if (pct <= 0) return "Down";
  if (pct <= 15) return "Critical";
  if (pct <= 35) return "Badly Wounded";
  if (pct <= 60) return "Wounded";
  if (pct <= 85) return "Scratched";
  return "Unhurt";
}

function getCombatantSpeed(combatant) {
  return clamp(Number(combatant?.speed ?? DEFAULT_MOVE_SPEED), 0, MAX_RANGE);
}

function buildPcCombatant(game, existingPc = {}, patch = {}) {
  const safeLevel = clamp(
    Number(patch.level ?? game.pc?.level ?? existingPc.level ?? 1),
    1,
    MAX_LEVEL
  );
  const baseWeapons = getInventoryWeapons(game.inventory);
  const hasUnarmed = baseWeapons.some((weapon) => weapon.id === UNARMED_WEAPON_ID);
  const weapons = ensureSingleEquippedWeapon(
    hasUnarmed ? baseWeapons : [...baseWeapons, { ...UNARMED_WEAPON }],
    patch.equippedWeaponId ?? existingPc.equippedWeaponId
  );
  const equippedWeaponId = weapons.find((weapon) => weapon.equipped)?.id ?? UNARMED_WEAPON_ID;
  const skillCatalog = getSkillCatalog(
    safeLevel,
    patch.skills ?? game.pc?.skills ?? existingPc.skills
  );
  const speed = clamp(Number(patch.speed ?? existingPc.speed ?? DEFAULT_MOVE_SPEED), 0, MAX_RANGE);
  const hpMax = clamp(Number(game.hp?.max ?? patch.hpMax ?? existingPc.hpMax ?? 12), 1, 999);
  const mpMax = clamp(Number(game.mp?.max ?? patch.mpMax ?? existingPc.mpMax ?? 0), 0, 999);
  return {
    id: existingPc.id ?? `pc_${game.gameId}`,
    name: game.pc?.name || existingPc.name || "Player",
    hpMax,
    hp: clamp(Number(patch.hp ?? existingPc.hp ?? game.hp?.current ?? hpMax), 0, hpMax),
    mpMax,
    mp: clamp(Number(patch.mp ?? existingPc.mp ?? game.mp?.current ?? mpMax), 0, mpMax),
    level: safeLevel,
    position: clamp(Number(patch.position ?? existingPc.position ?? 0), 0, 100),
    speed,
    movementRemaining: clamp(
      Number(patch.movementRemaining ?? existingPc.movementRemaining ?? speed),
      0,
      speed
    ),
    actionUsed: Boolean(patch.actionUsed ?? existingPc.actionUsed ?? false),
    defending: Boolean(patch.defending ?? existingPc.defending ?? false),
    dodging: Boolean(patch.dodging ?? existingPc.dodging ?? false),
    weapons,
    equippedWeaponId,
    skills: skillCatalog.allSkills,
  };
}

function buildEnemyCombatant(enemy, existingEnemy = {}, index = 0) {
  if (!enemy?.name && !existingEnemy?.name) return null;
  const hpMax = clamp(Number(enemy?.hpMax ?? existingEnemy?.hpMax ?? 10), 1, 999);
  const hp = clamp(Number(enemy?.hp ?? existingEnemy?.hp ?? hpMax), 0, hpMax);
  const safeLevel = clamp(Number(enemy?.level ?? existingEnemy?.level ?? 1), 1, MAX_LEVEL);
  const sourceWeapons = Array.isArray(enemy?.weapons)
    ? enemy.weapons
    : Array.isArray(existingEnemy?.weapons)
      ? existingEnemy.weapons
      : [];
  const normalizedWeapons = sourceWeapons
    .map((weapon, weaponIndex) =>
      normalizeWeapon(
        weapon,
        weapon?.name ?? `${enemy?.name ?? existingEnemy?.name} weapon ${weaponIndex + 1}`,
        "weapon_enemy"
      )
    )
    .filter(Boolean);
  const withDefaultWeapon =
    normalizedWeapons.length > 0 ? normalizedWeapons : [{ ...DEFAULT_ENEMY_WEAPON }];
  const weapons = ensureSingleEquippedWeapon(
    withDefaultWeapon,
    enemy?.equippedWeaponId ?? existingEnemy?.equippedWeaponId
  );
  const equippedWeaponId = weapons.find((weapon) => weapon.equipped)?.id ?? weapons[0].id;
  const rawSkills = Array.isArray(enemy?.skills)
    ? enemy.skills
    : Array.isArray(existingEnemy?.skills)
      ? existingEnemy.skills
      : [];
  const skills = rawSkills
    .map((skill, skillIndex) =>
      normalizeSkill(
        skill,
        skill?.name ?? `Skill ${skillIndex + 1}`,
        "skill_enemy"
      )
    )
    .filter(Boolean);
  const speed = clamp(
    Number(enemy?.speed ?? existingEnemy?.speed ?? DEFAULT_MOVE_SPEED),
    0,
    MAX_RANGE
  );
  return {
    id: enemy?.id ?? existingEnemy?.id ?? `enemy_${crypto.randomUUID()}`,
    name: enemy?.name ?? existingEnemy?.name ?? `Enemy ${index + 1}`,
    hp,
    hpMax,
    mp: clamp(Number(enemy?.mp ?? existingEnemy?.mp ?? 0), 0, 999),
    mpMax: clamp(Number(enemy?.mpMax ?? existingEnemy?.mpMax ?? 0), 0, 999),
    status: enemy?.status ?? existingEnemy?.status ?? getEnemyStatus(hp, hpMax),
    intent: enemy?.intent ?? existingEnemy?.intent ?? "",
    note: enemy?.note ?? existingEnemy?.note ?? "",
    level: safeLevel,
    position: clamp(Number(enemy?.position ?? existingEnemy?.position ?? DEFAULT_MELEE_RANGE), 0, 100),
    speed,
    movementRemaining: clamp(
      Number(enemy?.movementRemaining ?? existingEnemy?.movementRemaining ?? speed),
      0,
      speed
    ),
    actionUsed: Boolean(enemy?.actionUsed ?? existingEnemy?.actionUsed ?? false),
    defending: Boolean(enemy?.defending ?? existingEnemy?.defending ?? false),
    dodging: Boolean(enemy?.dodging ?? existingEnemy?.dodging ?? false),
    weapons,
    equippedWeaponId,
    skills,
  };
}

function isCombatantAlive(combatant) {
  return Number(combatant?.hp ?? 0) > 0;
}

function getCombatantRef(combat, combatantId) {
  if (!combat || !combatantId) return null;
  if (combat.pc?.id === combatantId) {
    return { kind: "pc", combatant: combat.pc };
  }
  const enemy = Array.isArray(combat.enemies)
    ? combat.enemies.find((entry) => entry.id === combatantId)
    : null;
  if (!enemy) return null;
  return { kind: "enemy", combatant: enemy };
}

function distanceBetweenCombatants(source, target) {
  return Math.abs(Number(source?.position ?? 0) - Number(target?.position ?? 0));
}

function getWeaponFromCombatant(combatant, requestedWeaponId) {
  const weapons = ensureSingleEquippedWeapon(
    Array.isArray(combatant?.weapons) ? combatant.weapons : [],
    combatant?.equippedWeaponId
  );
  combatant.weapons = weapons;
  combatant.equippedWeaponId = weapons.find((weapon) => weapon.equipped)?.id ?? null;
  if (weapons.length === 0) return null;
  const selectedId = requestedWeaponId ?? combatant.equippedWeaponId;
  const weapon = weapons.find((entry) => entry.id === selectedId && entry.equipped);
  return weapon ?? null;
}

function getUsableSkill(combatant, skillId) {
  if (!skillId) return null;
  const level = clamp(Number(combatant?.level ?? 1), 1, MAX_LEVEL);
  const skills = Array.isArray(combatant?.skills) ? combatant.skills : [];
  return (
    skills.find((skill) => skill.id === skillId && Number(skill.unlockLevel ?? 1) <= level) ??
    null
  );
}

function ensureCombatTurnState(combatant) {
  const speed = getCombatantSpeed(combatant);
  combatant.speed = speed;
  combatant.movementRemaining = clamp(
    Number(combatant.movementRemaining ?? speed),
    0,
    speed
  );
  combatant.actionUsed = Boolean(combatant.actionUsed);
}

function syncCombatState(game) {
  if (!game?.combat) return;
  const combat = game.combat;
  combat.round = clamp(Number(combat.round ?? 1), 1, 999);
  combat.pc = buildPcCombatant(game, combat.pc);
  combat.enemies = (Array.isArray(combat.enemies) ? combat.enemies : [])
    .map((enemy, index) => buildEnemyCombatant(enemy, enemy, index))
    .filter(Boolean);
  combat.enemies.forEach((enemy) => {
    enemy.status = getEnemyStatus(enemy.hp, enemy.hpMax);
    ensureCombatTurnState(enemy);
  });
  ensureCombatTurnState(combat.pc);
  combat.pc.hp = clamp(combat.pc.hp, 0, combat.pc.hpMax);
  combat.pc.mp = clamp(combat.pc.mp, 0, combat.pc.mpMax);
  game.hp.current = clamp(combat.pc.hp, 0, game.hp.max);
  game.mp.current = clamp(combat.pc.mp, 0, game.mp.max);
  game.pc.level = clamp(Number(combat.pc.level ?? game.pc.level ?? 1), 1, MAX_LEVEL);
  game.pc.skills = Array.isArray(combat.pc.skills)
    ? combat.pc.skills.map((skill) => normalizeSkill(skill, skill?.name, "skill")).filter(Boolean)
    : [];

  const fallbackInitiative = [
    { id: combat.pc.id, name: combat.pc.name, kind: "pc" },
    ...combat.enemies.map((enemy) => ({
      id: enemy.id,
      name: enemy.name,
      kind: "enemy",
    })),
  ];
  const candidateInitiative = Array.isArray(combat.initiative)
    ? combat.initiative
    : fallbackInitiative;
  const seen = new Set();
  const normalizedInitiative = candidateInitiative
    .map((entry) => {
      if (!entry?.id || seen.has(entry.id)) return null;
      const ref = getCombatantRef(combat, entry.id);
      if (!ref) return null;
      seen.add(entry.id);
      return {
        id: entry.id,
        name: ref.combatant.name,
        kind: ref.kind,
        initiative: normalizeInitiativeScore(entry.initiative),
      };
    })
    .filter(Boolean);

  const requiredEntries = [combat.pc, ...combat.enemies];
  requiredEntries.forEach((combatant) => {
    if (!seen.has(combatant.id)) {
      normalizedInitiative.push({
        id: combatant.id,
        name: combatant.name,
        kind: combat.pc.id === combatant.id ? "pc" : "enemy",
      });
    }
  });

  const withScores = applyInitiativeScores(normalizedInitiative);
  combat.initiative = withScores.sort((a, b) => b.initiative - a.initiative);
  const aliveTurnEntry = combat.initiative.find((entry) =>
    isCombatantAlive(getCombatantRef(combat, entry.id)?.combatant)
  );
  const currentTurnIsValid = combat.initiative.some(
    (entry) => entry.id === combat.currentTurnId
  );
  if (!currentTurnIsValid) {
    combat.currentTurnId = aliveTurnEntry?.id ?? combat.initiative[0]?.id ?? null;
  }

  const currentActorRef = getCombatantRef(combat, combat.currentTurnId);
  const currentActor = currentActorRef?.combatant ?? null;
  const currentSkills = currentActor
    ? getSkillCatalog(currentActor.level, currentActor.skills).unlockedSkills
    : [];
  combat.rules = {
    meleeRange: DEFAULT_MELEE_RANGE,
    actionTypes: ["attack", "defend", "dodge", "use_skill"],
    moveIsFree: true,
    oneActionPerTurn: true,
  };
  combat.turn = currentActor
    ? {
        actorId: currentActor.id,
        actorName: currentActor.name,
        kind: currentActorRef.kind,
        actionUsed: Boolean(currentActor.actionUsed),
        movementRemaining: Number(currentActor.movementRemaining ?? 0),
        equippedWeaponId: currentActor.equippedWeaponId ?? null,
        availableSkillIds: currentSkills.map((skill) => skill.id),
      }
    : null;
}

function resolveCombatOutcome(game) {
  if (!game?.combat) return null;
  const pcAlive = isCombatantAlive(game.combat.pc);
  const enemiesAlive = game.combat.enemies.some((enemy) => isCombatantAlive(enemy));
  if (!pcAlive) {
    game.combat = null;
    game.phase = "exploration";
    addLog(game, "Combat ended. The player is down.", "combat");
    return "player_down";
  }
  if (!enemiesAlive) {
    game.combat = null;
    game.phase = "exploration";
    addLog(game, "Combat ended. All enemies are down.", "combat");
    return "victory";
  }
  return null;
}

function advanceCombatTurn(game) {
  if (!game?.combat || !Array.isArray(game.combat.initiative) || game.combat.initiative.length === 0) {
    return { ok: false, message: "Initiative order is missing." };
  }
  const combat = game.combat;
  const currentIndex = Math.max(
    0,
    combat.initiative.findIndex((entry) => entry.id === combat.currentTurnId)
  );
  let wrapped = false;
  for (let offset = 1; offset <= combat.initiative.length; offset += 1) {
    const nextIndex = (currentIndex + offset) % combat.initiative.length;
    if (nextIndex <= currentIndex) wrapped = true;
    const candidateEntry = combat.initiative[nextIndex];
    const candidateRef = getCombatantRef(combat, candidateEntry.id);
    if (!candidateRef || !isCombatantAlive(candidateRef.combatant)) continue;
    combat.currentTurnId = candidateEntry.id;
    if (wrapped) {
      combat.round = clamp(Number(combat.round ?? 1) + 1, 1, 999);
    }
    candidateRef.combatant.actionUsed = false;
    candidateRef.combatant.defending = false;
    candidateRef.combatant.dodging = false;
    candidateRef.combatant.movementRemaining = getCombatantSpeed(candidateRef.combatant);
    syncCombatState(game);
    return { ok: true, actorName: candidateRef.combatant.name };
  }
  return { ok: false, message: "No living combatants are available in initiative." };
}

function applyCombatUpdate(game, combatUpdate) {
  if (!combatUpdate) return;
  if (combatUpdate.pcHp !== undefined) {
    game.hp.current = clamp(Number(combatUpdate.pcHp), 0, game.hp.max);
  }
  if (combatUpdate.pcHpDelta !== undefined) {
    game.hp.current = clamp(
      game.hp.current + Number(combatUpdate.pcHpDelta),
      0,
      game.hp.max
    );
  }
  if (combatUpdate.pcMp !== undefined) {
    game.mp.current = clamp(Number(combatUpdate.pcMp), 0, game.mp.max);
  }
  if (combatUpdate.pcMpDelta !== undefined) {
    game.mp.current = clamp(
      game.mp.current + Number(combatUpdate.pcMpDelta),
      0,
      game.mp.max
    );
  }
  if (combatUpdate.active === false) {
    game.combat = null;
    game.phase = "exploration";
    addLog(game, "Combat ended.", "combat");
    return;
  }

  if (combatUpdate.active === true) {
    const wasInCombat = game.phase === "combat" && game.combat;
    const existingCombat = game.combat ?? {};

    const hasExplicitEnemies = Array.isArray(combatUpdate.enemies);
    const hasSingleEnemyFields =
      combatUpdate.enemyName !== undefined ||
      combatUpdate.enemyHp !== undefined ||
      combatUpdate.enemyHpMax !== undefined ||
      combatUpdate.enemyIntent !== undefined;

    const existingEnemies = Array.isArray(existingCombat.enemies)
      ? existingCombat.enemies
      : [];
    let enemies = existingEnemies;

    if (hasExplicitEnemies) {
      enemies = combatUpdate.enemies
        .map((enemy, index) => {
          const existingEnemy = existingEnemies.find((entry) =>
            enemy?.id ? entry.id === enemy.id : entry.name === enemy?.name
          );
          return buildEnemyCombatant(enemy, existingEnemy, index);
        })
        .filter(Boolean);
    } else if (hasSingleEnemyFields) {
      enemies = [
        buildEnemyCombatant(
          {
            id: `enemy_${crypto.randomUUID()}`,
            name: combatUpdate.enemyName ?? "Unknown threat",
            hp: combatUpdate.enemyHp,
            hpMax: combatUpdate.enemyHpMax,
            intent: combatUpdate.enemyIntent,
          },
          null,
          0
        ),
      ].filter(Boolean);
    } else if (enemies.length === 0) {
      enemies = [
        buildEnemyCombatant(
          {
            id: `enemy_${crypto.randomUUID()}`,
            name: "Unknown threat",
            hp: 10,
            hpMax: 10,
          },
          null,
          0
        ),
      ].filter(Boolean);
    }

    const pcPatch = combatUpdate.pc ?? {};
    const pc = buildPcCombatant(game, existingCombat.pc ?? {}, pcPatch);

    const hasExplicitInitiative = Array.isArray(combatUpdate.initiative);
    let initiative = Array.isArray(existingCombat.initiative)
      ? [...existingCombat.initiative]
      : [];
    if (hasExplicitInitiative) {
      initiative = combatUpdate.initiative
        .map((entry) => {
          if (!entry?.name && !entry?.id) return null;
          const resolvedId =
            entry.id ??
            (entry.kind === "pc"
              ? pc.id
              : enemies.find((enemy) => enemy.name === entry.name)?.id) ??
            null;
          if (!resolvedId) return null;
          const isPc = resolvedId === pc.id;
          return {
            id: resolvedId,
            name: isPc
              ? pc.name
              : enemies.find((enemy) => enemy.id === resolvedId)?.name ?? entry.name ?? "Enemy",
            kind: isPc ? "pc" : "enemy",
            initiative: normalizeInitiativeScore(entry.initiative),
          };
        })
        .filter(Boolean)
        .sort((a, b) => Number(b.initiative ?? 0) - Number(a.initiative ?? 0));
    }

    const hasPcEntry = initiative.some((entry) => entry.id === pc.id);
    if (!hasPcEntry) {
      initiative.push({
        id: pc.id,
        name: pc.name,
        kind: "pc",
      });
    }
    enemies.forEach((enemy) => {
      const hasEnemyEntry = initiative.some((entry) => entry.id === enemy.id);
      if (!hasEnemyEntry) {
        initiative.push({
          id: enemy.id,
          name: enemy.name,
          kind: "enemy",
        });
      }
    });
    initiative = applyInitiativeScores(initiative).sort(
      (a, b) => Number(b.initiative ?? 0) - Number(a.initiative ?? 0)
    );

    let currentTurnId = combatUpdate.currentTurnId;
    if (!currentTurnId) {
      const previousCurrentTurnId = existingCombat.currentTurnId ?? null;
      const previousTurnStillExists = initiative.some(
        (entry) => entry.id === previousCurrentTurnId
      );
      currentTurnId = previousTurnStillExists
        ? previousCurrentTurnId
        : initiative[0]?.id ?? null;
    }

    game.combat = {
      round: Number(combatUpdate.round ?? existingCombat.round ?? 1),
      currentTurnId,
      pc,
      enemies,
      initiative,
    };
    game.phase = "combat";
    syncCombatState(game);
    if (
      game.combat &&
      getCombatantRef(game.combat, game.combat.currentTurnId)?.kind === "enemy"
    ) {
      const enemyResolution = resolveEnemyTurnsUntilPlayerTurn(game);
      if (!enemyResolution.ok) {
        addLog(game, `Enemy turn resolution failed: ${enemyResolution.message}`, "system");
      }
      syncCombatState(game);
    }

    if (!wasInCombat) {
      const enemyNames = enemies.map((enemy) => enemy.name).join(", ");
      addLog(game, `Combat begins with ${enemyNames}.`, "combat");
    }
  }
}

function applyDamage(combatant, amount) {
  const safeAmount = clamp(Number(amount ?? 0), 0, 999);
  if (!safeAmount) return 0;
  const before = combatant.hp;
  combatant.hp = clamp(Number(combatant.hp ?? 0) - safeAmount, 0, combatant.hpMax);
  return before - combatant.hp;
}

function applyHealing(combatant, amount) {
  const safeAmount = clamp(Number(amount ?? 0), 0, 999);
  if (!safeAmount) return 0;
  const before = combatant.hp;
  combatant.hp = clamp(Number(combatant.hp ?? 0) + safeAmount, 0, combatant.hpMax);
  return combatant.hp - before;
}

function resolveCombatAmount({ explicitAmount, formula, fallback = 0 }) {
  if (explicitAmount !== undefined) {
    return {
      amount: clamp(Number(explicitAmount), 0, 999),
      roll: null,
      source: "explicit",
    };
  }
  if (formula) {
    const roll = rollDice(formula);
    if (roll) {
      return {
        amount: clamp(Number(roll.total), 0, 999),
        roll,
        source: "rolled",
      };
    }
  }
  return {
    amount: clamp(Number(fallback), 0, 999),
    roll: null,
    source: "fallback",
  };
}

function rollInitiativeScore() {
  const roll = rollDice("d20");
  if (roll) return roll.total;
  return crypto.randomInt(1, 21);
}

function normalizeInitiativeScore(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function applyInitiativeScores(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const normalized = entries.map((entry) => ({
    ...entry,
    initiative: normalizeInitiativeScore(entry?.initiative),
  }));
  const allZero =
    normalized.length > 0 &&
    normalized.every((entry) => Number(entry.initiative ?? 0) === 0);
  const hasMissing = normalized.some((entry) => entry.initiative === null);
  if (!allZero && !hasMissing) {
    return normalized.map((entry) => ({
      ...entry,
      initiative: Number(entry.initiative),
    }));
  }
  return normalized.map((entry) => ({
    ...entry,
    initiative: rollInitiativeScore(),
  }));
}

function getWeaponRange(weapon) {
  if (!weapon) return 0;
  if (weapon.category === "melee") return DEFAULT_MELEE_RANGE;
  return clamp(Number(weapon.range ?? 1), 1, MAX_RANGE);
}

function moveCombatantToward(source, target, desiredDistance = 0) {
  const currentDistance = distanceBetweenCombatants(source, target);
  const maxMove = clamp(Number(source.movementRemaining ?? 0), 0, MAX_RANGE);
  const requiredMove = clamp(currentDistance - desiredDistance, 0, MAX_RANGE);
  const actualMove = clamp(Math.min(requiredMove, maxMove), 0, MAX_RANGE);
  if (actualMove <= 0) return 0;

  const direction = Number(target.position ?? 0) >= Number(source.position ?? 0) ? 1 : -1;
  const nextPosition = clamp(Number(source.position ?? 0) + direction * actualMove, 0, 100);
  const traveled = Math.abs(nextPosition - Number(source.position ?? 0));
  source.position = nextPosition;
  source.movementRemaining = clamp(maxMove - traveled, 0, source.speed);
  return traveled;
}

function resolveEnemyTurnOnce(game) {
  if (!game?.combat) {
    return { ok: false, message: "Combat is not active." };
  }
  syncCombatState(game);
  const combat = game.combat;
  const actorRef = getCombatantRef(combat, combat.currentTurnId);
  if (!actorRef || actorRef.kind !== "enemy") {
    return { ok: false, message: "Current turn is not an enemy turn." };
  }
  const enemy = actorRef.combatant;
  const pc = combat.pc;
  ensureCombatTurnState(enemy);
  const events = [];

  if (!isCombatantAlive(enemy)) {
    const advanceDown = advanceCombatTurn(game);
    if (!advanceDown.ok) return { ok: false, message: advanceDown.message };
    return {
      ok: true,
      summary: `${enemy.name} is down and cannot act.`,
    };
  }
  if (!isCombatantAlive(pc)) {
    return { ok: true, summary: "Player is already down." };
  }

  const weapon = getWeaponFromCombatant(enemy, null);
  if (!weapon) {
    enemy.actionUsed = true;
    enemy.defending = true;
    events.push(`${enemy.name} takes a defensive stance.`);
  } else {
    const attackRange = getWeaponRange(weapon);
    const moved = moveCombatantToward(enemy, pc, attackRange);
    if (moved > 0) {
      events.push(`${enemy.name} moves ${moved} to close distance.`);
    }

    const distance = distanceBetweenCombatants(enemy, pc);
    if (distance <= attackRange) {
      const damageResolution = resolveCombatAmount({
        explicitAmount: undefined,
        formula: weapon.damageFormula,
        fallback: 0,
      });
      enemy.actionUsed = true;
      const dealt = applyDamage(pc, damageResolution.amount);
      let attackMessage =
        dealt > 0
          ? `${enemy.name} attacks ${pc.name} with ${weapon.name} for ${dealt} damage.`
          : `${enemy.name} attacks ${pc.name} with ${weapon.name}.`;
      if (damageResolution.source === "rolled" && damageResolution.roll) {
        attackMessage += ` [${damageResolution.roll.formula}=${damageResolution.roll.total}]`;
      }
      events.push(attackMessage);
    } else {
      enemy.actionUsed = true;
      enemy.dodging = true;
      events.push(`${enemy.name} cannot reach attack range and takes evasive movement.`);
    }
  }

  events.forEach((entry) => addLog(game, entry, "combat"));
  syncCombatState(game);
  const outcome = resolveCombatOutcome(game);
  if (outcome) {
    return { ok: true, summary: events.join(" ") };
  }

  const advance = advanceCombatTurn(game);
  if (!advance.ok) {
    return { ok: false, message: advance.message };
  }
  return {
    ok: true,
    summary: events.join(" "),
  };
}

function resolveEnemyTurnsUntilPlayerTurn(game, maxTurns = 20) {
  const summaries = [];
  for (let turns = 0; turns < maxTurns; turns += 1) {
    if (!game?.combat) break;
    syncCombatState(game);
    const currentRef = getCombatantRef(game.combat, game.combat.currentTurnId);
    if (!currentRef || currentRef.kind !== "enemy") break;

    const resolved = resolveEnemyTurnOnce(game);
    if (!resolved.ok) {
      return { ok: false, message: resolved.message, summaries };
    }
    if (resolved.summary) summaries.push(resolved.summary);
    if (!game.combat) break;
  }
  return { ok: true, summaries };
}

function resolveTurnTransition(game) {
  const advance = advanceCombatTurn(game);
  if (!advance.ok) {
    return { ok: false, message: advance.message };
  }
  let summary = `Turn ends. It is now ${advance.actorName}'s turn.`;
  addLog(game, summary, "combat");

  const nextActorRef = game.combat
    ? getCombatantRef(game.combat, game.combat.currentTurnId)
    : null;
  if (nextActorRef?.kind === "enemy") {
    const enemyResolution = resolveEnemyTurnsUntilPlayerTurn(game);
    if (!enemyResolution.ok) {
      return { ok: false, message: enemyResolution.message };
    }
    if (enemyResolution.summaries.length > 0) {
      summary += ` Enemy turns resolved: ${enemyResolution.summaries.join(" ")}`;
    }
    if (game.combat) {
      const actorAfterEnemyTurns = getCombatantRef(
        game.combat,
        game.combat.currentTurnId
      )?.combatant;
      if (actorAfterEnemyTurns) {
        summary += ` It is now ${actorAfterEnemyTurns.name}'s turn.`;
      }
    }
  }
  return { ok: true, summary };
}

function resolveCombatAction(game, actionArgs = {}) {
  if (!game?.combat) {
    return { ok: false, message: "Combat is not active. Start combat first." };
  }
  syncCombatState(game);
  if (
    game.combat &&
    getCombatantRef(game.combat, game.combat.currentTurnId)?.kind === "enemy"
  ) {
    const enemyResolution = resolveEnemyTurnsUntilPlayerTurn(game);
    if (!enemyResolution.ok) {
      return { ok: false, message: enemyResolution.message };
    }
    syncCombatState(game);
    if (!game.combat) {
      return {
        ok: true,
        message:
          enemyResolution.summaries.length > 0
            ? `Enemy turns resolved: ${enemyResolution.summaries.join(" ")}`
            : "Enemy turns resolved.",
      };
    }
  }

  let combat = game.combat;
  let actorId = actionArgs.actorId ?? combat.currentTurnId;
  const actionType = actionArgs.action;
  let actorRef = getCombatantRef(combat, actorId);
  if (!actorRef) {
    return { ok: false, message: "Actor not found in this combat." };
  }
  if (combat.currentTurnId !== actorId) {
    return { ok: false, message: "Only the combatant whose turn it is can act." };
  }

  const actor = actorRef.combatant;
  ensureCombatTurnState(actor);
  if (!isCombatantAlive(actor)) {
    return { ok: false, message: `${actor.name} is down and cannot act.` };
  }
  if (
    actorRef.kind === "pc" &&
    COMBAT_ACTIONS_REQUIRING_ACTION.has(actionType) &&
    actionType !== "end_turn" &&
    actor.actionUsed
  ) {
    const transition = resolveTurnTransition(game);
    if (!transition.ok) {
      return { ok: false, message: transition.message };
    }
    syncCombatState(game);
    if (!game.combat) {
      return { ok: true, message: transition.summary };
    }
    combat = game.combat;
    actorId = combat.currentTurnId;
    actorRef = getCombatantRef(combat, actorId);
    if (!actorRef || actorRef.kind !== "pc") {
      return { ok: false, message: "Player turn is not ready yet. Try again." };
    }
  }
  const refreshedActor = actorRef.combatant;
  ensureCombatTurnState(refreshedActor);
  if (!isCombatantAlive(refreshedActor)) {
    return { ok: false, message: `${refreshedActor.name} is down and cannot act.` };
  }
  if (COMBAT_ACTIONS_REQUIRING_ACTION.has(actionType) && refreshedActor.actionUsed) {
    return {
      ok: false,
      message: `${refreshedActor.name} has already used an action this turn.`,
    };
  }

  const resolveTarget = (targetId) => {
    const targetRef = getCombatantRef(combat, targetId);
    if (!targetRef) return { error: "Target not found in this combat." };
    if (!isCombatantAlive(targetRef.combatant)) {
      return { error: `${targetRef.combatant.name} is already down.` };
    }
    return { targetRef };
  };

  let message = "";
  let usedAction = false;

  if (actionType === "move") {
    if (actionArgs.moveBy === undefined && actionArgs.moveTo === undefined) {
      return { ok: false, message: "Move requires moveBy or moveTo." };
    }
    const current = Number(actor.position ?? 0);
    const nextPosition =
      actionArgs.moveTo !== undefined
        ? clamp(Number(actionArgs.moveTo), 0, 100)
        : clamp(current + Number(actionArgs.moveBy), 0, 100);
    const distance = Math.abs(nextPosition - current);
    if (distance > Number(actor.movementRemaining ?? 0)) {
      return {
        ok: false,
        message: `${actor.name} only has ${actor.movementRemaining} movement remaining this turn.`,
      };
    }
    refreshedActor.position = nextPosition;
    refreshedActor.movementRemaining = clamp(
      refreshedActor.movementRemaining - distance,
      0,
      refreshedActor.speed
    );
    message = `${refreshedActor.name} moves to position ${refreshedActor.position}.`;
    addLog(game, message, "combat");
  } else if (actionType === "attack") {
    if (!actionArgs.targetId) {
      return { ok: false, message: "Attack requires a targetId." };
    }
    const targetResult = resolveTarget(actionArgs.targetId);
    if (targetResult.error) {
      return { ok: false, message: targetResult.error };
    }
    const { targetRef } = targetResult;
    if (targetRef.combatant.id === refreshedActor.id) {
      return { ok: false, message: "Attack target cannot be the same as the attacker." };
    }
    const weapon = getWeaponFromCombatant(refreshedActor, actionArgs.weaponId);
    if (!weapon) {
      return {
        ok: false,
        message: `${refreshedActor.name} must use an equipped weapon to attack.`,
      };
    }
    const attackRange =
      weapon.category === "melee"
        ? DEFAULT_MELEE_RANGE
        : clamp(Number(weapon.range ?? 1), 1, MAX_RANGE);
    const distance = distanceBetweenCombatants(refreshedActor, targetRef.combatant);
    if (distance > attackRange) {
      return {
        ok: false,
        message:
          `${targetRef.combatant.name} is out of range. ` +
          `${refreshedActor.name} needs range ${attackRange} but distance is ${distance}.`,
      };
    }
    const damageResolution = resolveCombatAmount({
      explicitAmount: actionArgs.damage,
      formula: weapon.damageFormula,
      fallback: 0,
    });
    refreshedActor.actionUsed = true;
    usedAction = true;
    const dealt = applyDamage(targetRef.combatant, damageResolution.amount);
    message =
      dealt > 0
        ? `${refreshedActor.name} attacks ${targetRef.combatant.name} with ${weapon.name} for ${dealt} damage.`
        : `${refreshedActor.name} attacks ${targetRef.combatant.name} with ${weapon.name}.`;
    if (damageResolution.source === "rolled" && damageResolution.roll) {
      message += ` [${damageResolution.roll.formula}=${damageResolution.roll.total}]`;
    }
    addLog(game, message, "combat");
  } else if (actionType === "defend") {
    refreshedActor.actionUsed = true;
    refreshedActor.defending = true;
    usedAction = true;
    message = `${refreshedActor.name} takes a defensive stance.`;
    addLog(game, message, "combat");
  } else if (actionType === "dodge") {
    refreshedActor.actionUsed = true;
    refreshedActor.dodging = true;
    usedAction = true;
    message = `${refreshedActor.name} focuses on dodging.`;
    addLog(game, message, "combat");
  } else if (actionType === "use_skill") {
    if (!actionArgs.skillId) {
      return { ok: false, message: "Using a skill requires skillId." };
    }
    const skill = getUsableSkill(refreshedActor, actionArgs.skillId);
    if (!skill) {
      return {
        ok: false,
        message: `${refreshedActor.name} does not have that unlocked skill.`,
      };
    }
    if (refreshedActor.mp < skill.mpCost) {
      return {
        ok: false,
        message: `${refreshedActor.name} does not have enough MP for ${skill.name}.`,
      };
    }

    let skillTargetRef = null;
    if (skill.target === "self") {
      skillTargetRef = actorRef;
    } else {
      if (!actionArgs.targetId) {
        return { ok: false, message: `${skill.name} requires a targetId.` };
      }
      const targetResult = resolveTarget(actionArgs.targetId);
      if (targetResult.error) {
        return { ok: false, message: targetResult.error };
      }
      skillTargetRef = targetResult.targetRef;
      const distance = distanceBetweenCombatants(refreshedActor, skillTargetRef.combatant);
      const skillRange = clamp(Number(skill.range ?? DEFAULT_MELEE_RANGE), 0, MAX_RANGE);
      if (distance > skillRange) {
        return {
          ok: false,
          message:
            `${skillTargetRef.combatant.name} is out of skill range. ` +
            `${skill.name} has range ${skillRange}, distance is ${distance}.`,
        };
      }
      if (skill.target === "enemy" && skillTargetRef.kind === actorRef.kind) {
        return { ok: false, message: `${skill.name} can only target enemies.` };
      }
      if (skill.target === "ally" && skillTargetRef.kind !== actorRef.kind) {
        return { ok: false, message: `${skill.name} can only target allies.` };
      }
    }

    refreshedActor.mp = clamp(refreshedActor.mp - skill.mpCost, 0, refreshedActor.mpMax);
    refreshedActor.actionUsed = true;
    usedAction = true;
    const dealt = applyDamage(skillTargetRef.combatant, actionArgs.damage ?? 0);
    const healed = applyHealing(skillTargetRef.combatant, actionArgs.heal ?? 0);
    message = `${refreshedActor.name} uses ${skill.name}${
      skillTargetRef.combatant.id !== refreshedActor.id
        ? ` on ${skillTargetRef.combatant.name}`
        : ""
    }.`;
    if (dealt > 0) message += ` ${dealt} damage dealt.`;
    if (healed > 0) message += ` ${healed} HP restored.`;
    addLog(game, message, "combat");
  } else if (actionType === "end_turn") {
    if (!refreshedActor.actionUsed) {
      return {
        ok: false,
        message: "A turn cannot end before using one action (attack, defend, dodge, or skill).",
      };
    }
    const transition = resolveTurnTransition(game);
    if (!transition.ok) {
      return { ok: false, message: transition.message };
    }
    message = transition.summary;
  } else {
    return { ok: false, message: "Unsupported combat action." };
  }

  if (usedAction && actorRef.kind === "pc") {
    const transition = resolveTurnTransition(game);
    if (!transition.ok) {
      return { ok: false, message: transition.message };
    }
    message = `${message} ${transition.summary}`.trim();
  }

  syncCombatState(game);
  const outcome = resolveCombatOutcome(game);
  if (outcome === "victory") {
    return { ok: true, message: `${message} Combat ends in victory.`.trim() };
  }
  if (outcome === "player_down") {
    return { ok: true, message: `${message} Combat ends with the player down.`.trim() };
  }
  return { ok: true, message };
}

const weaponInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  category: z.enum(["melee", "ranged"]).optional(),
  range: z.number().int().min(1).max(MAX_RANGE).optional(),
  equipped: z.boolean().optional(),
  damageFormula: z.string().optional(),
});

const skillInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  unlockLevel: z.number().int().min(1).max(MAX_LEVEL).optional(),
  mpCost: z.number().int().min(0).max(99).optional(),
  range: z.number().int().min(0).max(MAX_RANGE).optional(),
  target: z.enum(["enemy", "ally", "self"]).optional(),
  description: z.string().optional(),
});

const inventoryItemInputSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  qty: z.number().int().optional(),
  notes: z.string().optional(),
  weapon: weaponInputSchema.optional(),
});

const setupPreferencesSchema = z.object({
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

const beginSetupSchema = setupPreferencesSchema;

const confirmSetupSchema = setupPreferencesSchema
  .omit({ gameId: true })
  .extend({
    setupId: z.string(),
  });

const startGameSchema = setupPreferencesSchema.extend({
  setupId: z.string().optional(),
});

const newSessionSchema = setupPreferencesSchema.extend({
  mode: z.enum(["auto", "guided"]).optional(),
});

const getStateSchema = z.object({
  gameId: z.string(),
});

const rollDiceSchema = z.object({
  gameId: z.string(),
  formula: z.string(),
  reason: z.string().optional(),
});

const updateStateSchema = z.object({
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

const combatActionSchema = z.object({
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

const resetGameSchema = z.object({
  gameId: z.string(),
});

export function registerRpgTools(server) {
  server.registerResource(
    "rpg-widget",
    TOOL_OUTPUT_TEMPLATE,
    {},
    async () => ({
      contents: [
        {
          uri: TOOL_OUTPUT_TEMPLATE,
          mimeType: "text/html+skybridge",
          text: (() => {
            try {
              return readFileSync(widgetPath, "utf8");
            } catch (error) {
              console.error("Failed to load widget HTML:", error);
              return "<p>Widget UI missing. Rebuild web/dist/widget.html.</p>";
            }
          })(),
          _meta: { "openai/widgetPrefersBorder": true },
        },
      ],
    })
  );
  server.registerResource("rpg-guide", GAME_GUIDE_RESOURCE, {}, async () => ({
    contents: [
      {
        uri: GAME_GUIDE_RESOURCE,
        mimeType: "text/plain",
        text: GAME_GUIDE_TEXT,
      },
    ],
  }));

  const stripSetupControlFields = (args = {}) => {
    const { gameId, setupId, mode, ...rest } = args;
    return rest;
  };

  const formatSetupContent = (session, phase) => {
    const missingChoices = missingSetupChoices(session.startArgs, session.mode);
    const invalidChoices = invalidSetupChoices(session.startArgs, session.mode);
    return {
      type: "ttrpg_setup",
      phase,
      setupId: session.setupId,
      gameId: session.gameId,
      mode: session.mode,
      guideResourceUri: GAME_GUIDE_RESOURCE,
      guideSummary: GAME_GUIDE_SUMMARY,
      guide: GAME_GUIDE_TEXT,
      requiredChoices: getRequiredSetupChoices(session.mode),
      missingChoices,
      invalidChoices,
      providedChoices: {
        genre: session.startArgs.genre ?? "",
        tone: session.startArgs.tone ?? "",
        startingLocation: session.startArgs.startingLocation ?? "",
        stats: session.startArgs.stats ?? null,
        pc: session.startArgs.pc ?? {},
      },
      nextTool:
        missingChoices.length > 0 || invalidChoices.length > 0
          ? "confirm_setup"
          : "start_game",
      startGameArgsTemplate: missingChoices.length > 0 || invalidChoices.length > 0
        ? null
        : {
            ...session.startArgs,
            gameId: session.gameId,
            setupId: session.setupId,
          },
    };
  };

  const runStartGame = async (args) => {
    const requestedGameId = args?.gameId?.trim();
    let existing = await getGame(requestedGameId);
    let effectiveGameId = requestedGameId;
    let setupDefaults = {};
    let setupMode = "auto";

    if (!existing) {
      if (!args?.setupId) {
        return {
          content: [
            {
              type: "text",
              text:
                "This looks like a new game. Call new_session first. " +
                "It can auto-generate setup and start immediately.",
            },
          ],
          structuredContent: {
            type: "ttrpg_setup_required",
            nextTool: "new_session",
            suggestedArgs: { mode: "auto" },
          },
        };
      }

      const setupResult = consumeConfirmedSetupSession(args.setupId, requestedGameId);
      if (!setupResult.ok) {
        return replyWithError(setupResult.message);
      }
      effectiveGameId = setupResult.gameId;
      setupMode = setupResult.mode ?? "auto";
      setupDefaults = setupResult.startArgs ?? {};
      existing = await getGame(effectiveGameId);
    }

    const startArgs = mergeSetupArgs(setupDefaults, args ?? {});
    startArgs.gameId = effectiveGameId;
    const hasExplicitStartingStats = isCompleteStatsObject(startArgs.stats);
    const game = existing ?? createGameState({
      gameId: effectiveGameId,
      statFocus: startArgs.statFocus,
      stats: hasExplicitStartingStats ? startArgs.stats : undefined,
    });
    const previousLocation = String(game.location ?? "").trim();
    const previousSetupComplete = Boolean(game.setupComplete);
    game.stats = normalizeStats(game.stats);

    if (startArgs.genre !== undefined) game.genre = startArgs.genre.trim();
    if (startArgs.tone !== undefined) game.tone = startArgs.tone.trim();
    if (startArgs.startingLocation !== undefined) {
      game.location = startArgs.startingLocation.trim();
    }
    if (startArgs.pc) {
      game.pc = { ...game.pc, ...startArgs.pc };
      if (startArgs.pc.level !== undefined) {
        game.pc.level = clamp(Number(startArgs.pc.level), 1, MAX_LEVEL);
      }
      if (startArgs.pc.skills !== undefined) {
        game.pc.skills = (Array.isArray(startArgs.pc.skills) ? startArgs.pc.skills : [])
          .map((skill) => normalizeSkill(skill, skill?.name, "skill"))
          .filter(Boolean);
      }
    }
    if (startArgs.storyElements !== undefined) {
      game.storyElements = normalizeStoryElements(startArgs.storyElements);
    }
    if (hasExplicitStartingStats) {
      game.stats = normalizeStats(startArgs.stats, game.stats);
    }
    if (startArgs.startingInventory !== undefined) {
      game.inventory = startArgs.startingInventory
        .map((item) => normalizeInventoryItem(item))
        .filter(Boolean);
      syncInventoryWeaponEquipFlags(game.inventory);
    }

    const desiredHpMax = startArgs.hpMax ?? game.hp.max;
    const desiredMpMax = startArgs.mpMax ?? game.mp.max;

    game.hp.max = clamp(Number(desiredHpMax), 1, 999);
    game.mp.max = clamp(Number(desiredMpMax), 0, 999);

    const shouldResetVitals = !existing || game.phase === "setup";
    if (shouldResetVitals) {
      const startingHp =
        startArgs.startingHp !== undefined ? Number(startArgs.startingHp) : game.hp.max;
      const startingMp =
        startArgs.startingMp !== undefined ? Number(startArgs.startingMp) : game.mp.max;
      game.hp.current = clamp(startingHp, 0, game.hp.max);
      game.mp.current = clamp(startingMp, 0, game.mp.max);
    } else {
      if (startArgs.startingHp !== undefined) {
        game.hp.current = clamp(Number(startArgs.startingHp), 0, game.hp.max);
      } else {
        game.hp.current = clamp(game.hp.current, 0, game.hp.max);
      }
      if (startArgs.startingMp !== undefined) {
        game.mp.current = clamp(Number(startArgs.startingMp), 0, game.mp.max);
      } else {
        game.mp.current = clamp(game.mp.current, 0, game.mp.max);
      }
    }

    const missing = missingSetupChoices({
      genre: game.genre,
      stats: game.stats,
      pc: game.pc,
      startingLocation: game.location,
    }, setupMode);
    const invalid = invalidSetupChoices({ stats: game.stats }, setupMode);
    game.setupComplete = missing.length === 0 && invalid.length === 0;
    game.phase = game.setupComplete ? "exploration" : "setup";

    await persistGame(game);

    const message = game.setupComplete
      ? `Game ready. ${game.pc.name} enters the story.`
      : `Setup needs ${[...missing, ...invalid].join(", ")}.`;
    const movedToNewLocation =
      game.setupComplete &&
      String(game.location ?? "").trim() !== previousLocation;
    const startedAdventure = !previousSetupComplete && game.setupComplete;
    const imageRequest =
      startedAdventure || movedToNewLocation
        ? buildLocationImageRequest(
            game,
            startedAdventure ? "game_start" : "location_change"
          )
        : null;

    return replyWithState(game, message, { imageRequest });
  };

  server.registerTool(
    "new_session",
    {
      title: "Start new adventure",
      description:
        "Primary entry point for new games. " +
        "Use mode=auto to generate defaults and start immediately, or mode=guided to review setup first.",
      inputSchema: newSessionSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        ...commonToolMeta,
        "openai/toolInvocation/invoking": "Starting new session",
        "openai/toolInvocation/invoked": "Session flow updated",
      },
    },
    async (args) => {
      const mode = args?.mode === "guided" ? "guided" : "auto";
      const gameId = args?.gameId?.trim() || `game_${crypto.randomUUID()}`;
      const rawSetupArgs = stripSetupControlFields(args ?? {});
      const setupArgs = mode === "auto" ? applySetupDefaults(rawSetupArgs) : rawSetupArgs;
      const session = beginSetupSession(gameId, setupArgs, mode);
      const missingChoices = missingSetupChoices(session.startArgs, session.mode);
      const invalidChoices = invalidSetupChoices(session.startArgs, session.mode);

      if (mode === "guided" && (missingChoices.length > 0 || invalidChoices.length > 0)) {
        const needs = [...missingChoices, ...invalidChoices];
        return {
          content: [
            {
              type: "text",
              text:
                `Setup started. Missing/invalid ${needs.join(", ")}. ` +
                "Review the guide and call confirm_setup with the setupId and remaining choices.",
            },
          ],
          structuredContent: formatSetupContent(session, "begin"),
        };
      }

      const confirmResult = confirmSetupSession(session.setupId, {});
      if (!confirmResult.ok) {
        return replyWithError(confirmResult.message);
      }

      return await runStartGame({
        ...session.startArgs,
        gameId: session.gameId,
        setupId: session.setupId,
      });
    }
  );

  server.registerTool(
    "begin_setup",
    {
      title: "Begin setup (advanced)",
      description:
        "Start the setup wizard. Returns guide summary, required choices, and a setupId for confirm_setup.",
      inputSchema: beginSetupSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Starting setup wizard",
        "openai/toolInvocation/invoked": "Setup wizard started",
      },
    },
    async (args) => {
      const gameId = args?.gameId?.trim() || `game_${crypto.randomUUID()}`;
      const setupArgs = stripSetupControlFields(args ?? {});
      const session = beginSetupSession(gameId, setupArgs, "guided");
      const missingChoices = missingSetupChoices(session.startArgs, session.mode);
      const invalidChoices = invalidSetupChoices(session.startArgs, session.mode);
      const needs = [...missingChoices, ...invalidChoices];

      return {
        content: [
          {
            type: "text",
            text:
              needs.length > 0
                ? `Setup started. Missing/invalid ${needs.join(", ")}. Call confirm_setup next.`
                : "Setup started with all required choices. Call confirm_setup to finalize.",
          },
        ],
        structuredContent: formatSetupContent(session, "begin"),
      };
    }
  );

  server.registerTool(
    "confirm_setup",
    {
      title: "Confirm setup (advanced)",
      description:
        "Confirm setup choices for a setupId. After success, call start_game with setupId and gameId.",
      inputSchema: confirmSetupSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        "openai/toolInvocation/invoking": "Confirming setup",
        "openai/toolInvocation/invoked": "Setup confirmation updated",
      },
    },
    async (args) => {
      const { setupId } = args;
      const setupArgs = stripSetupControlFields(args ?? {});
      const result = confirmSetupSession(setupId, setupArgs);
      if (!result.ok) {
        if (result.session) {
          return {
            content: [{ type: "text", text: result.message }],
            structuredContent: formatSetupContent(result.session, "confirm"),
          };
        }
        return replyWithError(result.message);
      }

      return {
        content: [
          {
            type: "text",
            text:
              "Setup confirmed. Call start_game with setupId and gameId to begin play.",
          },
        ],
        structuredContent: formatSetupContent(result.session, "confirmed"),
      };
    }
  );

  server.registerTool(
    "start_game",
    {
      title: "Begin adventure or update setup",
      description:
        "Finalize setup and enter play. Usually call new_session for new games.",
      inputSchema: startGameSchema,
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
      },
      _meta: {
        ...commonToolMeta,
        "openai/toolInvocation/invoking": "Setting up the adventure",
        "openai/toolInvocation/invoked": "Adventure setup updated",
      },
    },
    async (args) => await runStartGame(args)
  );

  server.registerTool(
    "get_state",
    {
      title: "Get game state",
      description: "Return the latest game state snapshot.",
      inputSchema: getStateSchema,
      _meta: {
        ...commonToolMeta,
        "openai/toolInvocation/invoking": "Loading game state",
        "openai/toolInvocation/invoked": "Game state loaded",
      },
    },
    async (args) => {
      const game = await getGame(args?.gameId);
      if (!game) {
        return replyWithError("Game not found. Start a new game first.");
      }
      return replyWithState(game, "Current state loaded.");
    }
  );

  server.registerTool(
    "roll_dice",
    {
      title: "Roll dice",
      description: "Roll dice using a formula like d20, 2d6+1, or 3d4-2.",
      inputSchema: rollDiceSchema,
      _meta: {
        ...commonToolMeta,
        "openai/toolInvocation/invoking": "Rolling dice",
        "openai/toolInvocation/invoked": "Dice rolled",
      },
    },
    async (args) => {
      const game = await getGame(args?.gameId);
      if (!game) {
        return replyWithError("Game not found. Start a new game first.");
      }

      const result = rollDice(args?.formula);
      if (!result) {
        return replyWithState(game, "Invalid dice formula. Try d20 or 2d6+1.");
      }

      game.lastRoll = {
        ...result,
        reason: args?.reason ?? "",
        at: nowIso(),
      };

      addLog(
        game,
        `Rolled ${result.formula} for ${args?.reason ?? "an action"}: ${
          result.total
        }`,
        "roll"
      );

      await persistGame(game);
      return replyWithState(
        game,
        `Rolled ${result.formula}: ${result.total}.`
      );
    }
  );

  server.registerTool(
    "update_state",
    {
      title: "Update game state",
      description:
        "Apply HP/MP changes, inventory updates, location changes, or combat updates.",
      inputSchema: updateStateSchema,
      _meta: {
        ...commonToolMeta,
        "openai/toolInvocation/invoking": "Updating the game",
        "openai/toolInvocation/invoked": "Game updated",
      },
    },
    async (args) => {
      const game = await getGame(args?.gameId);
      if (!game) {
        return replyWithError("Game not found. Start a new game first.");
      }
      const previousLocation = String(game.location ?? "").trim();

      if (args?.pc) {
        game.pc = { ...game.pc, ...args.pc };
        if (args.pc.level !== undefined) {
          game.pc.level = clamp(Number(args.pc.level), 1, MAX_LEVEL);
        }
      }
      const incomingSkills = args?.skills ?? args?.pc?.skills;
      if (incomingSkills !== undefined) {
        game.pc.skills = (Array.isArray(incomingSkills) ? incomingSkills : [])
          .map((skill) => normalizeSkill(skill, skill?.name, "skill"))
          .filter(Boolean);
      }

      const combatUpdate = args?.combat
        ? { ...args.combat }
        : null;
      const inActiveCombat = game.phase === "combat" && Boolean(game.combat);
      const hasHpMutation =
        args?.hp !== undefined ||
        args?.hpDelta !== undefined ||
        args?.mp !== undefined ||
        args?.mpDelta !== undefined ||
        combatUpdate?.pcHp !== undefined ||
        combatUpdate?.pcHpDelta !== undefined ||
        combatUpdate?.pcMp !== undefined ||
        combatUpdate?.pcMpDelta !== undefined;
      const mutatesCombatState = Boolean(combatUpdate && combatUpdate.active !== false);
      if (inActiveCombat && (hasHpMutation || mutatesCombatState)) {
        return replyWithError(
          "Active combat is rule-locked. Use combat_action for attacks, skills, movement, and turn flow."
        );
      }

      if (args?.hp !== undefined) {
        game.hp.current = clamp(Number(args.hp), 0, game.hp.max);
      }
      if (args?.mp !== undefined) {
        game.mp.current = clamp(Number(args.mp), 0, game.mp.max);
      }
      if (args?.hpDelta !== undefined) {
        game.hp.current = clamp(game.hp.current + Number(args.hpDelta), 0, game.hp.max);
      }
      if (args?.mpDelta !== undefined) {
        game.mp.current = clamp(game.mp.current + Number(args.mpDelta), 0, game.mp.max);
      }
      if (args?.location !== undefined) {
        game.location = args.location.trim();
      }

      applyInventoryDelta(game, args?.inventory);
      if (args?.inventory?.equipWeaponId) {
        syncInventoryWeaponEquipFlags(game.inventory, args.inventory.equipWeaponId);
      }
      if (combatUpdate) {
        const hasTopLevelHp =
          args?.hp !== undefined || args?.hpDelta !== undefined;
        const hasTopLevelMp =
          args?.mp !== undefined || args?.mpDelta !== undefined;
        if (hasTopLevelHp) {
          delete combatUpdate.pcHp;
          delete combatUpdate.pcHpDelta;
        }
        if (hasTopLevelMp) {
          delete combatUpdate.pcMp;
          delete combatUpdate.pcMpDelta;
        }
      }
      applyCombatUpdate(game, combatUpdate);
      syncCombatState(game);

      if (args?.logEntry) {
        addLog(game, args.logEntry, args.logKind ?? "story");
      }

      await persistGame(game);
      const movedToNewLocation =
        args?.location !== undefined &&
        game.setupComplete &&
        String(game.location ?? "").trim() !== previousLocation;
      const imageRequest = movedToNewLocation
        ? buildLocationImageRequest(game, "location_change")
        : null;
      return replyWithState(game, "Game state updated.", { imageRequest });
    }
  );

  server.registerTool(
    "combat_action",
    {
      title: "Resolve combat action",
      description:
        "Execute one combat turn action with rules enforcement (equipped weapon, range, skills, and one action per turn). Player action turns auto-advance and enemy turns auto-resolve.",
      inputSchema: combatActionSchema,
      _meta: {
        ...commonToolMeta,
        "openai/toolInvocation/invoking": "Resolving combat action",
        "openai/toolInvocation/invoked": "Combat action resolved",
      },
    },
    async (args) => {
      const game = await getGame(args?.gameId);
      if (!game) {
        return replyWithError("Game not found. Start a new game first.");
      }
      const result = resolveCombatAction(game, args);
      if (!result.ok) {
        await persistGame(game);
        return replyWithError(result.message);
      }
      await persistGame(game);
      return replyWithState(game, result.message);
    }
  );

  server.registerTool(
    "reset_game",
    {
      title: "Reset game",
      description: "Reset the game back to a fresh setup state.",
      inputSchema: resetGameSchema,
      _meta: {
        ...commonToolMeta,
        "openai/toolInvocation/invoking": "Resetting the game",
        "openai/toolInvocation/invoked": "Game reset",
      },
    },
    async (args) => {
      const existing = await getGame(args?.gameId);
      if (!existing) {
        return replyWithError("Game not found. Start a new game first.");
      }

      const reset = createGameState({
        gameId: existing.gameId,
        genre: existing.genre,
        tone: existing.tone,
        pc: existing.pc,
      });

      await persistGame(reset);
      return replyWithState(reset, "Game reset.");
    }
  );

}

export function createRpgServer() {
  const server = new McpServer({ name: "ttrpg-mcp", version: "0.1.0" });
  registerRpgTools(server);
  return server;
}

export const MCP_PATH = "/mcp";

export async function handleMcpRequest(req, res) {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  if (req.method === "GET") {
    const hasSessionId = Boolean(req.headers["mcp-session-id"]);
    const accept = String(req.headers.accept ?? "");
    const wantsJson = accept.includes("application/json");
    if (!hasSessionId && !wantsJson) {
      res.writeHead(200, { "content-type": "text/plain" }).end("TTRPG MCP server");
      return;
    }
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (!req.method || !MCP_METHODS.has(req.method)) {
    res.writeHead(405, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    }).end("Method Not Allowed");
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  const server = createRpgServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.writeHead(500).end("Internal server error");
    }
  }
}
