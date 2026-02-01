import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const widgetPath = path.join(__dirname, "../web/dist/widget.html");

const widgetHtml = readFileSync(widgetPath, "utf8");

const TOOL_OUTPUT_TEMPLATE = "ui://widget/rpg.html";
const commonToolMeta = {
  "openai/outputTemplate": TOOL_OUTPUT_TEMPLATE,
};

const games = new Map();

const baseStats = { str: 2, agi: 2, int: 2, cha: 2 };

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nowIso() {
  return new Date().toISOString();
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
    const enemiesInput = Array.isArray(combatUpdate.enemies)
      ? combatUpdate.enemies
      : [];

    const enemies =
      enemiesInput.length > 0
        ? enemiesInput
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
            .filter(Boolean)
        : [
            {
              id: `enemy_${crypto.randomUUID()}`,
              name: combatUpdate.enemyName ?? "Unknown threat",
              hp: clamp(
                Number(combatUpdate.enemyHp ?? combatUpdate.enemyHpMax ?? 10),
                0,
                clamp(Number(combatUpdate.enemyHpMax ?? 10), 1, 999)
              ),
              hpMax: clamp(Number(combatUpdate.enemyHpMax ?? 10), 1, 999),
              status: getEnemyStatus(
                Number(combatUpdate.enemyHp ?? combatUpdate.enemyHpMax ?? 10),
                Number(combatUpdate.enemyHpMax ?? 10)
              ),
              intent: combatUpdate.enemyIntent ?? "",
              note: "",
            },
          ];

    const initiativeInput = Array.isArray(combatUpdate.initiative)
      ? combatUpdate.initiative
      : [];

    const initiative = initiativeInput
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

    game.combat = {
      round: Number(combatUpdate.round ?? 1),
      currentTurnId: combatUpdate.currentTurnId ?? initiative[0]?.id ?? null,
      enemies,
      initiative,
    };
    game.phase = "combat";
    const enemyNames = enemies.map((enemy) => enemy.name).join(", ");
    addLog(game, `Combat begins with ${enemyNames}.`, "combat");
  }
}

const startGameSchema = z.object({
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

function createRpgServer() {
  const server = new McpServer({ name: "ttrpg-mcp", version: "0.1.0" });

  server.registerResource(
    "rpg-widget",
    TOOL_OUTPUT_TEMPLATE,
    {},
    async () => ({
      contents: [
        {
          uri: TOOL_OUTPUT_TEMPLATE,
          mimeType: "text/html+skybridge",
          text: widgetHtml,
          _meta: { "openai/widgetPrefersBorder": true },
        },
      ],
    })
  );

  server.registerTool(
    "start_game",
    {
      title: "Start or update game setup",
      description:
        "Create a new game or update the setup details for the current TTRPG session.",
      inputSchema: startGameSchema,
      _meta: {
        ...commonToolMeta,
        "openai/toolInvocation/invoking": "Setting up the adventure",
        "openai/toolInvocation/invoked": "Adventure setup updated",
      },
    },
    async (args) => {
      const existing = getGame(args?.gameId);
      const game = existing ?? createGameState({ gameId: args?.gameId });

      if (args?.genre !== undefined) game.genre = args.genre.trim();
      if (args?.tone !== undefined) game.tone = args.tone.trim();
      if (args?.startingLocation !== undefined) {
        game.location = args.startingLocation.trim();
      }
      if (args?.pc) {
        game.pc = { ...game.pc, ...args.pc };
      }
      if (args?.storyElements !== undefined) {
        game.storyElements = normalizeStoryElements(args.storyElements);
      }
      if (args?.startingInventory !== undefined) {
        game.inventory = args.startingInventory
          .filter((item) => item?.name)
          .map((item) => ({
            id: `item_${crypto.randomUUID()}`,
            name: item.name,
            qty: clamp(Number(item.qty ?? 1), 1, 999),
            notes: item.notes ?? "",
          }));
      }

      const desiredHpMax = args?.hpMax ?? game.hp.max;
      const desiredMpMax = args?.mpMax ?? game.mp.max;

      game.hp.max = clamp(Number(desiredHpMax), 1, 999);
      game.mp.max = clamp(Number(desiredMpMax), 0, 999);

      const shouldResetVitals = !existing || game.phase === "setup";
      if (shouldResetVitals) {
        const startingHp =
          args?.startingHp !== undefined ? Number(args.startingHp) : game.hp.max;
        const startingMp =
          args?.startingMp !== undefined ? Number(args.startingMp) : game.mp.max;
        game.hp.current = clamp(startingHp, 0, game.hp.max);
        game.mp.current = clamp(startingMp, 0, game.mp.max);
      } else {
        if (args?.startingHp !== undefined) {
          game.hp.current = clamp(Number(args.startingHp), 0, game.hp.max);
        } else {
          game.hp.current = clamp(game.hp.current, 0, game.hp.max);
        }
        if (args?.startingMp !== undefined) {
          game.mp.current = clamp(Number(args.startingMp), 0, game.mp.max);
        } else {
          game.mp.current = clamp(game.mp.current, 0, game.mp.max);
        }
      }

      if (!existing && args?.statFocus) {
        game.stats = withStatFocus(game.stats, args.statFocus);
      }

      const missing = [];
      if (!game.genre) missing.push("genre");
      if (!game.pc.name) missing.push("pc.name");
      if (!game.pc.archetype) missing.push("pc.archetype");

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
    }
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
      applyCombatUpdate(game, args?.combat);

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

  return server;
}

const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" }).end("TTRPG MCP server");
    return;
  }

  const MCP_METHODS = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
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
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`TTRPG MCP server listening on http://localhost:${port}${MCP_PATH}`);
});
