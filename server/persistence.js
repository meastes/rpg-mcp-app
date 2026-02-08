import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA ?? "public";
const SUPABASE_GAMES_TABLE = process.env.SUPABASE_GAMES_TABLE ?? "rpg_games";

let supabaseClient = null;

export function isPersistenceEnabled() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

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
