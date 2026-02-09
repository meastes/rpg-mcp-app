import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA ?? "public";
const SUPABASE_GAMES_TABLE = process.env.SUPABASE_GAMES_TABLE ?? "rpg_games";
const SUPABASE_ENV_DEBUG = process.env.SUPABASE_ENV_DEBUG === "1";

let supabaseClient = null;

export function isPersistenceEnabled() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function parseProjectRefFromUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return url.hostname.split(".")[0] ?? null;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token) {
  if (!token || !token.includes(".")) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payloadPart = parts[1];
  const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function summarizeKey(rawKey) {
  if (!rawKey) {
    return { present: false };
  }
  const key = String(rawKey).trim();
  const payload = decodeJwtPayload(key);
  return {
    present: true,
    length: key.length,
    prefix: key.slice(0, 12),
    jwtRole: payload?.role ?? null,
    jwtRef: payload?.ref ?? null,
    jwtExp: payload?.exp ?? null,
  };
}

function logEnvDiagnostics() {
  if (!SUPABASE_ENV_DEBUG) return;
  const projectRef = parseProjectRefFromUrl(SUPABASE_URL);
  const keySummary = summarizeKey(SUPABASE_SERVICE_ROLE_KEY);
  const hasRefMismatch =
    Boolean(projectRef) &&
    Boolean(keySummary.jwtRef) &&
    projectRef !== keySummary.jwtRef;
  console.log("[supabase-env]", {
    urlPresent: Boolean(SUPABASE_URL),
    projectRef,
    schema: SUPABASE_SCHEMA,
    table: SUPABASE_GAMES_TABLE,
    key: keySummary,
    persistenceEnabled: isPersistenceEnabled(),
    hasRefMismatch,
  });
}

logEnvDiagnostics();

function getSupabaseClient() {
  if (!isPersistenceEnabled()) return null;
  if (supabaseClient) return supabaseClient;
  supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    global: { headers: { "X-Client-Info": "rpg-mcp-app" } },
  });
  return supabaseClient;
}

export async function loadGameState(gameId) {
  if (!gameId || !isPersistenceEnabled()) return null;
  const client = getSupabaseClient();
  const { data, error } = await client
    .schema(SUPABASE_SCHEMA)
    .from(SUPABASE_GAMES_TABLE)
    .select("state")
    .eq("game_id", gameId)
    .maybeSingle();
  if (error) {
    console.error("Supabase load failed:", error);
    return null;
  }
  return data?.state ?? null;
}

export async function saveGameState(game) {
  if (!game || !isPersistenceEnabled()) {
    return { ok: false, reason: "Persistence disabled" };
  }
  const client = getSupabaseClient();
  const payload = {
    game_id: game.gameId,
    state: game,
    updated_at: new Date().toISOString(),
  };
  const { error } = await client
    .schema(SUPABASE_SCHEMA)
    .from(SUPABASE_GAMES_TABLE)
    .upsert(payload, { onConflict: "game_id" });
  if (error) {
    console.error("Supabase save failed:", error);
    return { ok: false, error };
  }
  return { ok: true };
}
