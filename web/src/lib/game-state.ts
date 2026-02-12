export const SET_GLOBALS_EVENT = "openai:set_globals";
export const GENERATE_IMAGE_TOOLTIP =
  "In order to generate the image, remove the app from the chat field. An image cannot be generated while the app is selected in chat. Remember to add the app back after generating the image in order to continue the game.";

export type LogEntry = {
  id: string;
  at: string;
  kind: string;
  text: string;
};

export type InventoryItem = {
  id: string;
  name: string;
  qty: number;
  notes?: string;
};

export type CombatState = {
  round?: number;
  currentTurnId?: string | null;
  enemies?: Array<{
    id?: string;
    name: string;
    hp?: number;
    hpMax?: number;
    status?: EnemySeverity | string;
    intent?: string;
    note?: string;
  }>;
  initiative?: Array<{
    id?: string;
    name: string;
    kind?: "pc" | "enemy";
    initiative?: number;
  }>;
};

export type GameState = {
  type: "ttrpg_state";
  gameId: string;
  phase: "setup" | "exploration" | "combat" | string;
  setupComplete: boolean;
  genre?: string;
  tone?: string;
  storyElements?: string[];
  pc?: {
    name?: string;
    pronouns?: string;
    archetype?: string;
    background?: string;
    goal?: string;
  };
  stats?: {
    str: number;
    agi: number;
    con: number;
    int: number;
    wis: number;
    cha: number;
  };
  hp?: { current: number; max: number };
  mp?: { current: number; max: number };
  inventory?: InventoryItem[];
  location?: string;
  imageRequest?: {
    type?: string;
    gameId?: string;
    trigger?: string;
    location?: string;
    prompt?: string;
    requestedAt?: string;
  } | null;
  combat?: CombatState | null;
  lastRoll?: { formula: string; total: number; reason?: string } | null;
  log?: LogEntry[];
};

export type ToolOutput = GameState | { type: string } | null;

export type SetGlobalsEvent = CustomEvent<{ globals: { toolOutput?: ToolOutput } }>;

export type EnemySeverity =
  | "Unhurt"
  | "Scratched"
  | "Wounded"
  | "Badly Wounded"
  | "Critical"
  | "Down";

export type Enemy = {
  id: string;
  name: string;
  severity: EnemySeverity;
  note?: string;
};

export type InitiativeEntry = {
  id: string;
  name: string;
  kind: "pc" | "enemy";
  initiative: number;
};

export type GameMode = "explore" | "combat";

export type StatKey = "STR" | "DEX" | "CON" | "INT" | "WIS" | "CHA";

export const severityTone: Record<
  EnemySeverity,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  Unhurt: { label: "Unhurt", variant: "outline" },
  Scratched: { label: "Scratched", variant: "secondary" },
  Wounded: { label: "Wounded", variant: "default" },
  "Badly Wounded": { label: "Badly", variant: "default" },
  Critical: { label: "Critical", variant: "destructive" },
  Down: { label: "Down", variant: "destructive" },
};

export const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

export function formatStatValue(value?: number) {
  if (value === undefined || value === null || Number.isNaN(value)) return "--";
  return value;
}

export function formatStatModifier(value?: number) {
  if (value === undefined || value === null || Number.isNaN(value)) return "--";
  return value >= 0 ? `+${value}` : `${value}`;
}

function getSeverityFromPercent(percent: number): EnemySeverity {
  if (percent <= 0) return "Down";
  if (percent <= 15) return "Critical";
  if (percent <= 35) return "Badly Wounded";
  if (percent <= 60) return "Wounded";
  if (percent <= 85) return "Scratched";
  return "Unhurt";
}

export function normalizeEnemySeverity(
  status?: string,
  hp?: number,
  hpMax?: number
): EnemySeverity {
  if (status && status in severityTone) {
    return status as EnemySeverity;
  }
  const safeMax = Number.isFinite(Number(hpMax)) && Number(hpMax) > 0 ? Number(hpMax) : 0;
  const safeHp = Number.isFinite(Number(hp)) ? Number(hp) : 0;
  if (!safeMax) return "Unhurt";
  const percent = Math.round((safeHp / safeMax) * 100);
  return getSeverityFromPercent(percent);
}

export function buildStats(game: GameState): Record<StatKey, number | undefined> {
  return {
    STR: game.stats?.str,
    DEX: game.stats?.agi,
    CON: game.stats?.con,
    INT: game.stats?.int,
    WIS: game.stats?.wis,
    CHA: game.stats?.cha,
  };
}

export function buildEnemies(game: GameState): Enemy[] {
  return (game.combat?.enemies ?? [])
    .filter((enemy) => enemy?.name)
    .map((enemy) => ({
      id: enemy.id ?? `enemy_${enemy.name}`,
      name: enemy.name,
      severity: normalizeEnemySeverity(enemy.status, enemy.hp, enemy.hpMax),
      note: enemy.note ?? enemy.intent ?? "",
    }));
}

export function buildInitiative(game: GameState): InitiativeEntry[] {
  return (game.combat?.initiative ?? [])
    .filter((entry) => entry?.name)
    .map<InitiativeEntry>((entry) => ({
      id: entry.id ?? `init_${entry.name}`,
      name: entry.name,
      kind: entry.kind === "enemy" ? "enemy" : "pc",
      initiative: Number(entry.initiative ?? 0),
    }))
    .sort((a, b) => b.initiative - a.initiative);
}

export function getGameMode(game: GameState): GameMode {
  return game.phase === "combat" || Boolean(game.combat) ? "combat" : "explore";
}
