import { normalizeStats, normalizeStoryElements, nowIso } from "./core-utils.js";

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

export function buildLocationImageRequest(game, trigger = "location_change") {
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

export function summarizeState(game, { imageRequest } = {}) {
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

export function replyWithState(game, message, { imageRequest } = {}) {
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

export function replyWithError(message) {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { type: "ttrpg_error", message },
  };
}
