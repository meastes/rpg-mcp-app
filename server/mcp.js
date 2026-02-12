import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isPersistenceEnabled,
  loadGameState,
  saveGameState,
} from "./persistence.js";
import {
  GAME_GUIDE_RESOURCE,
  GAME_GUIDE_SUMMARY,
  GAME_GUIDE_TEXT,
  MAX_LEVEL,
  TOOL_OUTPUT_TEMPLATE,
  commonToolMeta,
} from "./mcp/constants.js";
import {
  beginSetupSchema,
  combatActionSchema,
  confirmSetupSchema,
  getStateSchema,
  newSessionSchema,
  resetGameSchema,
  rollDiceSchema,
  startGameSchema,
  updateStateSchema,
} from "./mcp/schemas.js";
import {
  buildStartingStats,
  clamp,
  normalizeStats,
  normalizeStoryElements,
  nowIso,
  rollDice,
} from "./mcp/core-utils.js";
import {
  applySetupDefaults,
  beginSetupSession,
  confirmSetupSession,
  consumeConfirmedSetupSession,
  getRequiredSetupChoices,
  invalidSetupChoices,
  isCompleteStatsObject,
  mergeSetupArgs,
  missingSetupChoices,
} from "./mcp/setup-flow.js";
import {
  buildLocationImageRequest,
  replyWithError,
  replyWithState,
} from "./mcp/state-view.js";
import {
  applyInventoryDelta,
  normalizeInventoryItem,
  normalizeSkill,
  syncInventoryWeaponEquipFlags,
} from "./mcp/player-data.js";
import { createCombatSystem } from "./mcp/combat-system.js";

const widgetPath = path.join(process.cwd(), "web/dist/widget.html");

const games = new Map();

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

function addLog(game, entry, kind = "system") {
  if (!entry) return;
  game.log.push({
    id: `log_${crypto.randomUUID()}`,
    at: nowIso(),
    kind,
    text: entry,
  });
}

const combatSystem = createCombatSystem({ addLog });

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
      combatSystem.applyCombatUpdate(game, combatUpdate);
      combatSystem.syncCombatState(game);

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
      const result = combatSystem.resolveCombatAction(game, args);
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
