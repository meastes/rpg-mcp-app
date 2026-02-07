import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const widgetPath = path.join(process.cwd(), "web/dist/widget.html");

const TOOL_OUTPUT_TEMPLATE = "ui://widget/rpg.html";
const commonToolMeta = {
  "openai/outputTemplate": TOOL_OUTPUT_TEMPLATE,
};
const GAME_GUIDE_RESOURCE = "rpg://guide";
const SETUP_SESSION_TTL_MS = 30 * 60 * 1000;
const REQUIRED_SETUP_CHOICES = ["genre", "pc.name", "pc.archetype"];
const GAME_GUIDE_SUMMARY =
  "Read the guide, pick genre/tone and core character details, then confirm setup before starting.";
const DEFAULT_GENRES = [
  "Heroic Fantasy",
  "Sword and Sorcery",
  "Grimdark Frontier",
];
const DEFAULT_TONES = ["Adventurous", "Mystic", "Gritty"];
const DEFAULT_ARCHETYPES = ["Ranger", "Warrior", "Mage", "Rogue", "Cleric"];
const DEFAULT_PC_NAMES = ["Rowan", "Kestrel", "Iris", "Thorn", "Ash"];
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

const baseStats = { str: 2, agi: 2, int: 2, cha: 2 };

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function pickRandom(list, fallback) {
  if (!Array.isArray(list) || list.length === 0) return fallback;
  const index = crypto.randomInt(0, list.length);
  return list[index];
}

function applySetupDefaults(args = {}) {
  const merged = mergeSetupArgs({}, args);
  if (!merged.genre) merged.genre = pickRandom(DEFAULT_GENRES, "Heroic Fantasy");
  if (!merged.tone) merged.tone = pickRandom(DEFAULT_TONES, "Adventurous");
  merged.pc = merged.pc ?? {};
  if (!merged.pc.name) merged.pc.name = pickRandom(DEFAULT_PC_NAMES, "Traveler");
  if (!merged.pc.archetype) {
    merged.pc.archetype = pickRandom(DEFAULT_ARCHETYPES, "Ranger");
  }
  return merged;
}

function missingSetupChoices(args = {}) {
  const missing = [];
  if (!args.genre) missing.push("genre");
  if (!args.pc?.name) missing.push("pc.name");
  if (!args.pc?.archetype) missing.push("pc.archetype");
  return missing;
}

function beginSetupSession(gameId, startArgs = {}) {
  purgeExpiredSetupSessions();
  const setupId = `setup_${crypto.randomUUID()}`;
  setupSessions.set(setupId, {
    setupId,
    gameId,
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
  const missing = missingSetupChoices(session.startArgs);
  if (missing.length > 0) {
    return {
      ok: false,
      message:
        `Setup still needs ${missing.join(", ")}.`,
      missingChoices: missing,
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
  return { ok: true, gameId: session.gameId, startArgs: session.startArgs };
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
    },
    stats: { ...baseStats },
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

  return { ...stats, [focus]: clamp(stats[focus] + 1, 1, 5) };
}

function getGame(gameId) {
  if (!gameId) return null;
  return games.get(gameId) ?? null;
}

function persistGame(game) {
  game.updatedAt = nowIso();
  games.set(game.gameId, game);
  return game;
}

function summarizeState(game) {
  return {
    type: "ttrpg_state",
    gameId: game.gameId,
    phase: game.phase,
    setupComplete: game.setupComplete,
    genre: game.genre,
    tone: game.tone,
    storyElements: game.storyElements,
    pc: game.pc,
    stats: game.stats,
    hp: game.hp,
    mp: game.mp,
    inventory: game.inventory,
    location: game.location,
    combat: game.combat,
    lastRoll: game.lastRoll,
    log: game.log.slice(-12),
    updatedAt: game.updatedAt,
  };
}

function replyWithState(game, message) {
  return {
    content: message ? [{ type: "text", text: message }] : [],
    structuredContent: summarizeState(game),
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
      } else {
        game.inventory.push({
          id: `item_${crypto.randomUUID()}`,
          name: item.name,
          qty,
          notes: item.notes ?? "",
        });
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

    let enemies = Array.isArray(existingCombat.enemies)
      ? [...existingCombat.enemies]
      : [];

    if (hasExplicitEnemies) {
      enemies = combatUpdate.enemies
        .map((enemy) => {
          if (!enemy?.name) return null;
          const hpMax = clamp(Number(enemy.hpMax ?? 10), 1, 999);
          const hp = clamp(Number(enemy.hp ?? hpMax), 0, hpMax);
          return {
            id: enemy.id ?? `enemy_${crypto.randomUUID()}`,
            name: enemy.name,
            hp,
            hpMax,
            status: enemy.status ?? getEnemyStatus(hp, hpMax),
            intent: enemy.intent ?? "",
            note: enemy.note ?? "",
          };
        })
        .filter(Boolean);
    } else if (hasSingleEnemyFields) {
      const hpMax = clamp(Number(combatUpdate.enemyHpMax ?? 10), 1, 999);
      const hp = clamp(Number(combatUpdate.enemyHp ?? hpMax), 0, hpMax);
      enemies = [
        {
          id: `enemy_${crypto.randomUUID()}`,
          name: combatUpdate.enemyName ?? "Unknown threat",
          hp,
          hpMax,
          status: getEnemyStatus(hp, hpMax),
          intent: combatUpdate.enemyIntent ?? "",
          note: "",
        },
      ];
    } else if (enemies.length === 0) {
      enemies = [
        {
          id: `enemy_${crypto.randomUUID()}`,
          name: "Unknown threat",
          hp: 10,
          hpMax: 10,
          status: "Unhurt",
          intent: "",
          note: "",
        },
      ];
    }

    const hasExplicitInitiative = Array.isArray(combatUpdate.initiative);
    let initiative = Array.isArray(existingCombat.initiative)
      ? [...existingCombat.initiative]
      : [];
    if (hasExplicitInitiative) {
      initiative = combatUpdate.initiative
        .map((entry) => {
          if (!entry?.name) return null;
          return {
            id: entry.id ?? `init_${crypto.randomUUID()}`,
            name: entry.name,
            kind: entry.kind === "enemy" ? "enemy" : "pc",
            initiative: Number(entry.initiative ?? 0),
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.initiative - a.initiative);
    }

    if (initiative.length > 0 && game.pc?.name) {
      const hasPc = initiative.some((entry) => entry.kind === "pc");
      if (!hasPc) {
        initiative.push({
          id: `init_${crypto.randomUUID()}`,
          name: game.pc.name,
          kind: "pc",
          initiative: 0,
        });
        initiative.sort((a, b) => b.initiative - a.initiative);
      }
    }

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
      enemies,
      initiative,
    };
    game.phase = "combat";

    if (!wasInCombat) {
      const enemyNames = enemies.map((enemy) => enemy.name).join(", ");
      addLog(game, `Combat begins with ${enemyNames}.`, "combat");
    }
  }
}

const setupPreferencesSchema = z.object({
  gameId: z.string().optional(),
  genre: z.string().optional(),
  tone: z.string().optional(),
  storyElements: z.union([z.array(z.string()), z.string()]).optional(),
  startingLocation: z.string().optional(),
  startingInventory: z
    .array(
      z.object({
        name: z.string(),
        qty: z.number().int().optional(),
        notes: z.string().optional(),
      })
    )
    .optional(),
  hpMax: z.number().int().min(1).max(999).optional(),
  mpMax: z.number().int().min(0).max(999).optional(),
  startingHp: z.number().int().min(0).max(999).optional(),
  startingMp: z.number().int().min(0).max(999).optional(),
  statFocus: z.enum(["str", "agi", "int", "cha"]).optional(),
  pc: z
    .object({
      name: z.string().optional(),
      pronouns: z.string().optional(),
      archetype: z.string().optional(),
      background: z.string().optional(),
      goal: z.string().optional(),
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
  inventory: z
    .object({
      add: z
        .array(
          z.object({
            name: z.string(),
            qty: z.number().int().optional(),
            notes: z.string().optional(),
          })
        )
        .optional(),
      remove: z
        .array(
          z.object({
            id: z.string(),
            qty: z.number().int().optional(),
          })
        )
        .optional(),
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
    const missingChoices = missingSetupChoices(session.startArgs);
    return {
      type: "ttrpg_setup",
      phase,
      setupId: session.setupId,
      gameId: session.gameId,
      guideResourceUri: GAME_GUIDE_RESOURCE,
      guideSummary: GAME_GUIDE_SUMMARY,
      guide: GAME_GUIDE_TEXT,
      requiredChoices: REQUIRED_SETUP_CHOICES,
      missingChoices,
      providedChoices: {
        genre: session.startArgs.genre ?? "",
        tone: session.startArgs.tone ?? "",
        pc: session.startArgs.pc ?? {},
      },
      nextTool: missingChoices.length ? "confirm_setup" : "start_game",
      startGameArgsTemplate: missingChoices.length
        ? null
        : {
            ...session.startArgs,
            gameId: session.gameId,
            setupId: session.setupId,
          },
    };
  };

  const runStartGame = (args) => {
    const requestedGameId = args?.gameId?.trim();
    let existing = getGame(requestedGameId);
    let effectiveGameId = requestedGameId;
    let setupDefaults = {};

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
      setupDefaults = setupResult.startArgs ?? {};
      existing = getGame(effectiveGameId);
    }

    const startArgs = mergeSetupArgs(setupDefaults, args ?? {});
    startArgs.gameId = effectiveGameId;
    const game = existing ?? createGameState({ gameId: effectiveGameId });

    if (startArgs.genre !== undefined) game.genre = startArgs.genre.trim();
    if (startArgs.tone !== undefined) game.tone = startArgs.tone.trim();
    if (startArgs.startingLocation !== undefined) {
      game.location = startArgs.startingLocation.trim();
    }
    if (startArgs.pc) {
      game.pc = { ...game.pc, ...startArgs.pc };
    }
    if (startArgs.storyElements !== undefined) {
      game.storyElements = normalizeStoryElements(startArgs.storyElements);
    }
    if (startArgs.startingInventory !== undefined) {
      game.inventory = startArgs.startingInventory
        .filter((item) => item?.name)
        .map((item) => ({
          id: `item_${crypto.randomUUID()}`,
          name: item.name,
          qty: clamp(Number(item.qty ?? 1), 1, 999),
          notes: item.notes ?? "",
        }));
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

    if (!existing && startArgs.statFocus) {
      game.stats = withStatFocus(game.stats, startArgs.statFocus);
    }

    const missing = missingSetupChoices({ genre: game.genre, pc: game.pc });
    game.setupComplete = missing.length === 0;
    game.phase = game.setupComplete ? "exploration" : "setup";

    if (game.setupComplete && !game.location) {
      game.location = "Unknown frontier";
    }

    persistGame(game);

    const message = game.setupComplete
      ? `Game ready. ${game.pc.name} enters the story.`
      : `Setup needs ${missing.join(", ")}.`;

    return replyWithState(game, message);
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
      const session = beginSetupSession(gameId, setupArgs);
      const missingChoices = missingSetupChoices(session.startArgs);

      if (mode === "guided" && missingChoices.length > 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `Setup started. Missing ${missingChoices.join(", ")}. ` +
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

      return runStartGame({
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
      const session = beginSetupSession(gameId, setupArgs);
      const missingChoices = missingSetupChoices(session.startArgs);

      return {
        content: [
          {
            type: "text",
            text:
              missingChoices.length > 0
                ? `Setup started. Missing ${missingChoices.join(", ")}. Call confirm_setup next.`
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
    async (args) => runStartGame(args)
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
      const game = getGame(args?.gameId);
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
      const game = getGame(args?.gameId);
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

      persistGame(game);
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
      const game = getGame(args?.gameId);
      if (!game) {
        return replyWithError("Game not found. Start a new game first.");
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
      const combatUpdate = args?.combat
        ? { ...args.combat }
        : null;
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

      if (args?.logEntry) {
        addLog(game, args.logEntry, args.logKind ?? "story");
      }

      persistGame(game);
      return replyWithState(game, "Game state updated.");
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
      const existing = getGame(args?.gameId);
      if (!existing) {
        return replyWithError("Game not found. Start a new game first.");
      }

      const reset = createGameState({
        gameId: existing.gameId,
        genre: existing.genre,
        tone: existing.tone,
        pc: existing.pc,
      });

      persistGame(reset);
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
