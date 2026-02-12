import crypto from "node:crypto";
import { STAT_KEYS, STANDARD_ARRAY, baseStats } from "./constants.js";

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function withStatFocus(stats, focus) {
  if (!focus || !Object.prototype.hasOwnProperty.call(stats, focus)) {
    return stats;
  }

  return { ...stats, [focus]: clamp(stats[focus] + 1, 1, 20) };
}

export function normalizeStats(rawStats = {}, fallbackStats = baseStats) {
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

export function buildStartingStats(statFocus) {
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

export function nowIso() {
  return new Date().toISOString();
}

export function parseDiceFormula(formula) {
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

export function rollDice(formula) {
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

export function normalizeStoryElements(raw) {
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

export function slugifyId(value, fallback = "entry") {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || fallback;
}
