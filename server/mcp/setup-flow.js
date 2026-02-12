import crypto from "node:crypto";
import {
  BASE_REQUIRED_SETUP_CHOICES,
  DEFAULT_ARCHETYPES,
  DEFAULT_GENRES,
  DEFAULT_PC_NAMES,
  DEFAULT_STARTING_LOCATIONS,
  DEFAULT_TONES,
  GUIDED_ONLY_REQUIRED_SETUP_CHOICES,
  SETUP_SESSION_TTL_MS,
  STAT_KEYS,
} from "./constants.js";

const setupSessions = new Map();

function purgeExpiredSetupSessions() {
  const now = Date.now();
  for (const [setupId, entry] of setupSessions.entries()) {
    if (!entry || entry.expiresAt <= now) {
      setupSessions.delete(setupId);
    }
  }
}

export function mergeSetupArgs(base = {}, patch = {}) {
  return {
    ...base,
    ...patch,
    pc: {
      ...(base.pc ?? {}),
      ...(patch.pc ?? {}),
    },
  };
}

export function isCompleteStatsObject(stats) {
  if (!stats || typeof stats !== "object") return false;
  return STAT_KEYS.every((key) => Number.isFinite(Number(stats[key])));
}

function isGuideAlignedStartingStats(stats) {
  if (!isCompleteStatsObject(stats)) return false;
  const values = STAT_KEYS.map((key) => Number(stats[key]));
  return values.every((value) => Number.isInteger(value) && value >= 8 && value <= 15);
}

export function getRequiredSetupChoices(mode = "guided") {
  return mode === "guided"
    ? [...BASE_REQUIRED_SETUP_CHOICES, ...GUIDED_ONLY_REQUIRED_SETUP_CHOICES]
    : [...BASE_REQUIRED_SETUP_CHOICES];
}

function pickRandom(list, fallback) {
  if (!Array.isArray(list) || list.length === 0) return fallback;
  const index = crypto.randomInt(0, list.length);
  return list[index];
}

export function applySetupDefaults(args = {}) {
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

export function missingSetupChoices(args = {}, mode = "guided") {
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

export function invalidSetupChoices(args = {}, mode = "guided") {
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

export function beginSetupSession(gameId, startArgs = {}, mode = "guided") {
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

export function confirmSetupSession(setupId, patchArgs = {}) {
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

export function consumeConfirmedSetupSession(setupId, requestedGameId) {
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
