import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardDescription,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Backpack,
  BarChart3,
  Heart,
  ListOrdered,
  MapPin,
  Sparkles,
  Swords,
  Wand2,
} from "lucide-react";

const SET_GLOBALS_EVENT = "openai:set_globals";
const GENERATE_IMAGE_TOOLTIP =
  "In order to generate the image, remove the app from the chat field. An image cannot be generated while the app is selected in chat. Remember to add the app back after generating the image in order to continue the game.";

type LogEntry = {
  id: string;
  at: string;
  kind: string;
  text: string;
};

type InventoryItem = {
  id: string;
  name: string;
  qty: number;
  notes?: string;
};

type CombatState = {
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

type GameState = {
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

type ToolOutput = GameState | { type: string } | null;

type SetGlobalsEvent = CustomEvent<{ globals: { toolOutput?: ToolOutput } }>;

type EnemySeverity =
  | "Unhurt"
  | "Scratched"
  | "Wounded"
  | "Badly Wounded"
  | "Critical"
  | "Down";

type Enemy = {
  id: string;
  name: string;
  severity: EnemySeverity;
  note?: string;
};

type InitiativeEntry = {
  id: string;
  name: string;
  kind: "pc" | "enemy";
  initiative: number;
};

type GameMode = "explore" | "combat";

type StatKey = "STR" | "DEX" | "CON" | "INT" | "WIS" | "CHA";

const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

const severityTone: Record<
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

function useToolOutput(): ToolOutput {
  const [output, setOutput] = useState<ToolOutput>(
    () => window.openai?.toolOutput ?? null
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as SetGlobalsEvent).detail;
      if (detail?.globals?.toolOutput !== undefined) {
        setOutput(detail.globals.toolOutput ?? null);
      }
    };

    window.addEventListener(SET_GLOBALS_EVENT, handler, { passive: true });
    return () => window.removeEventListener(SET_GLOBALS_EVENT, handler);
  }, []);

  return output;
}

function ResourceMeter({
  label,
  icon,
  value,
  max,
  tone,
  note,
}: {
  label: string;
  icon: ReactNode;
  value: number;
  max: number;
  tone: "hp" | "mp";
  note: string;
}) {
  const safeMax = Math.max(0, max);
  const safeValue = clamp(value, 0, safeMax);
  const pct = safeMax > 0 ? Math.round((safeValue / safeMax) * 100) : 0;
  const indicatorStyle =
    tone === "hp"
      ? { backgroundColor: "color-mix(in oklab, var(--destructive) 80%, white 20%)" }
      : { backgroundColor: "color-mix(in oklab, var(--primary) 78%, white 22%)" };

  return (
    <div className="rounded-lg border bg-card/60 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background/70">
            {icon}
          </span>
          <p className="text-sm font-medium">{label}</p>
        </div>
        <div className="text-right text-sm tabular-nums">
          <span className="font-semibold">{safeValue}</span>
          <span className="text-muted-foreground">/{safeMax}</span>
        </div>
      </div>
      <Progress
        value={pct}
        className="mt-2 h-1.5 rounded-full bg-secondary/70"
        indicatorStyle={indicatorStyle}
      />
      <p className="mt-2 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function LoadingPanel() {
  return (
    <div className="relative mx-auto w-full max-w-2xl px-3 pb-4 pt-3 sm:px-4 sm:pt-4">
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-64 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.17),transparent_66%)]" />
      <Card className="overflow-hidden rounded-2xl border-border/75 bg-card/80 shadow-lg backdrop-blur">
        <CardHeader className="space-y-4 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-8 w-44 bg-secondary/50" />
              <Skeleton className="h-4 w-56 bg-secondary/50" />
            </div>
            <Skeleton className="h-6 w-24 rounded-full bg-secondary/50" />
          </div>
          <Skeleton className="h-8 w-44 bg-secondary/50" />
        </CardHeader>

        <Separator />

        <CardContent className="p-4 sm:p-5">
          <div className="grid h-auto w-full grid-cols-3 gap-1 rounded-lg border border-border/70 bg-background/20 p-1">
            <Skeleton className="h-8 bg-secondary/50" />
            <Skeleton className="h-8 bg-secondary/50" />
            <Skeleton className="h-8 bg-secondary/50" />
          </div>

          <div className="mt-4 space-y-3">
            <div className="rounded-lg border bg-card/60 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-7 w-7 bg-secondary/50" />
                  <Skeleton className="h-4 w-14 bg-secondary/50" />
                </div>
                <Skeleton className="h-4 w-14 bg-secondary/50" />
              </div>
              <Skeleton className="mt-2 h-1.5 w-full bg-secondary/50" />
              <Skeleton className="mt-2 h-3 w-32 bg-secondary/50" />
            </div>

            <div className="rounded-lg border bg-card/60 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-7 w-7 bg-secondary/50" />
                  <Skeleton className="h-4 w-14 bg-secondary/50" />
                </div>
                <Skeleton className="h-4 w-14 bg-secondary/50" />
              </div>
              <Skeleton className="mt-2 h-1.5 w-full bg-secondary/50" />
              <Skeleton className="mt-2 h-3 w-44 bg-secondary/50" />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function formatStatValue(value?: number) {
  if (value === undefined || value === null || Number.isNaN(value)) return "--";
  return value;
}

function formatStatModifier(value?: number) {
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

function normalizeEnemySeverity(
  status?: string,
  hp?: number,
  hpMax?: number
): EnemySeverity {
  if (status && status in severityTone) {
    return status as EnemySeverity;
  }
  const safeMax = Number.isFinite(hpMax) && hpMax ? hpMax : 0;
  const safeHp = Number.isFinite(hp) ? hp : 0;
  if (!safeMax) return "Unhurt";
  const percent = Math.round((safeHp / safeMax) * 100);
  return getSeverityFromPercent(percent);
}

export function App() {
  const toolOutput = useToolOutput();
  const [followUpState, setFollowUpState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const [followUpError, setFollowUpError] = useState("");
  const copiedResetTimerRef = useRef<number | null>(null);
  const game = useMemo(() => {
    if (toolOutput && "type" in toolOutput && toolOutput.type === "ttrpg_state") {
      return toolOutput as GameState;
    }
    return null;
  }, [toolOutput]);
  const isLoading = toolOutput === null;
  const imageRequest = game?.imageRequest ?? null;

  useEffect(() => {
    setFollowUpState("idle");
    setFollowUpError("");
    if (copiedResetTimerRef.current) {
      window.clearTimeout(copiedResetTimerRef.current);
      copiedResetTimerRef.current = null;
    }
  }, [imageRequest?.requestedAt, imageRequest?.prompt]);

  useEffect(
    () => () => {
      if (copiedResetTimerRef.current) {
        window.clearTimeout(copiedResetTimerRef.current);
      }
    },
    []
  );

  if (!game) {
    if (isLoading) {
      return <LoadingPanel />;
    }
    return null;
  }

  const inventory = game.inventory ?? [];
  const mode: GameMode =
    game.phase === "combat" || Boolean(game.combat) ? "combat" : "explore";
  const characterName = game.pc?.name ?? "Unnamed hero";

  const hpMax = game.hp?.max ?? 0;
  const hp = game.hp?.current ?? 0;
  const hpPercent = hpMax > 0 ? Math.round((clamp(hp, 0, hpMax) / hpMax) * 100) : 0;
  const mpMax = game.mp?.max ?? 0;
  const mp = game.mp?.current ?? 0;

  const stats: Record<StatKey, number | undefined> = {
    STR: game.stats?.str,
    DEX: game.stats?.agi,
    CON: game.stats?.con,
    INT: game.stats?.int,
    WIS: game.stats?.wis,
    CHA: game.stats?.cha,
  };

  const enemies: Enemy[] = (game.combat?.enemies ?? [])
    .filter((enemy) => enemy?.name)
    .map((enemy) => ({
      id: enemy.id ?? `enemy_${enemy.name}`,
      name: enemy.name,
      severity: normalizeEnemySeverity(enemy.status, enemy.hp, enemy.hpMax),
      note: enemy.note ?? enemy.intent ?? "",
    }));

  const initiative: InitiativeEntry[] = (game.combat?.initiative ?? [])
    .filter((entry) => entry?.name)
    .map((entry) => ({
      id: entry.id ?? `init_${entry.name}`,
      name: entry.name,
      kind: entry.kind === "enemy" ? "enemy" : "pc",
      initiative: Number(entry.initiative ?? 0),
    }))
    .sort((a, b) => b.initiative - a.initiative);

  const currentTurnId =
    game.combat?.currentTurnId ?? (initiative[0]?.id ?? null);

  const statusChip =
    mode === "combat"
      ? { label: "Combat", icon: <Swords className="h-4 w-4" />, accent: "outline" }
      : {
          label: "Exploration",
          icon: <BarChart3 className="h-4 w-4" />,
          accent: "secondary",
        };

  const copyScenePromptToClipboard = async () => {
    if (!imageRequest?.prompt) return;

    const prompt = `Generate an image of the following: ${imageRequest.prompt}`;

    setFollowUpError("");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = prompt;
        textArea.setAttribute("readonly", "");
        textArea.style.position = "absolute";
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.select();
        const copied = document.execCommand("copy");
        document.body.removeChild(textArea);
        if (!copied) {
          throw new Error("Browser prevented clipboard copy.");
        }
      }
      setFollowUpState("copied");
      if (copiedResetTimerRef.current) {
        window.clearTimeout(copiedResetTimerRef.current);
      }
      copiedResetTimerRef.current = window.setTimeout(() => {
        setFollowUpState("idle");
        copiedResetTimerRef.current = null;
      }, 2200);
    } catch (error) {
      setFollowUpState("failed");
      setFollowUpError(
        error instanceof Error ? error.message : "Unable to copy image prompt."
      );
    }
  };

  return (
    <div className="relative mx-auto w-full max-w-2xl px-3 pb-4 pt-3 sm:px-4 sm:pt-4">
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-64 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.17),transparent_66%)]" />

      <Card className="overflow-hidden rounded-2xl border-border/75 bg-card/80 shadow-lg backdrop-blur">
        <CardHeader className="space-y-4 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle
                className="truncate text-[clamp(1.35rem,3.1vw,2rem)] leading-tight tracking-tight"
              >
                {characterName}
              </CardTitle>
              <CardDescription className="mt-1.5 flex items-center gap-2">
                <MapPin className="h-4 w-4 shrink-0" />
                <span className="truncate">
                  {game.location ? game.location : "Unknown location"}
                </span>
              </CardDescription>
            </div>
            <Badge
              variant={statusChip.accent as "secondary" | "outline"}
              className="rounded-full"
            >
              <span className="inline-flex items-center gap-1.5">
                {statusChip.icon}
                {statusChip.label}
              </span>
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {imageRequest?.prompt && (
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={copyScenePromptToClipboard}
                      className="gap-2 border border-border/90"
                    >
                      <Wand2 className="h-3.5 w-3.5" />
                      {followUpState === "copied" ? "Prompt copied" : "Copy location image prompt"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs whitespace-normal sm:max-w-sm">
                    {GENERATE_IMAGE_TOOLTIP}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>

          {followUpState === "failed" && (
            <p className="text-xs text-destructive">
              Copy failed{followUpError ? `: ${followUpError}` : "."}
            </p>
          )}
        </CardHeader>

        <Separator />

        <CardContent className="p-4 sm:p-5">
          <Tabs defaultValue="resources" className="w-full">
            <TabsList className="grid h-auto w-full grid-cols-3 gap-1 rounded-lg border border-border/70 bg-background/20 p-1">
              <TabsTrigger value="resources" className="gap-2">
                <Heart className="h-4 w-4" />
                Resources
              </TabsTrigger>
              <TabsTrigger value="stats" className="gap-2">
                <BarChart3 className="h-4 w-4" />
                Stats
              </TabsTrigger>
              <TabsTrigger value="inventory" className="gap-2">
                <Backpack className="h-4 w-4" />
                Inventory
              </TabsTrigger>
            </TabsList>

            <TabsContent value="resources" className="mt-4 space-y-3">
              <ResourceMeter
                label="HP"
                icon={<Heart className="h-4 w-4" />}
                value={hp}
                max={hpMax}
                tone="hp"
                note={
                  hpPercent <= 25 ? "Critical: healing recommended." : "Stable condition."
                }
              />

              {mpMax > 0 && (
                <ResourceMeter
                  label="MP"
                  icon={<Sparkles className="h-4 w-4" />}
                  value={mp}
                  max={mpMax}
                  tone="mp"
                  note="Spend carefully before entering major encounters."
                />
              )}
            </TabsContent>

            <TabsContent value="stats" className="mt-4">
              <div className="grid grid-cols-3 gap-3">
              {(Object.keys(stats) as StatKey[]).map((key) => (
                <div
                  key={key}
                  className="rounded-lg border bg-background/10 p-3 text-center"
                >
                  <p className="text-xs font-medium text-muted-foreground">{key}</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums">
                    {formatStatValue(stats[key])}
                  </p>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {formatStatModifier(stats[key])}
                  </p>
                </div>
              ))}
              </div>
            </TabsContent>

            <TabsContent value="inventory" className="mt-4">
              <ScrollArea className="h-[260px] pr-2">
                <div className="space-y-2">
              {inventory.length === 0 ? (
                <div className="rounded-lg border bg-background/10 px-4 py-6 text-center">
                  <div className="mx-auto mb-2 grid h-9 w-9 place-items-center rounded-full border bg-secondary/40">
                    <Backpack className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <p className="font-medium">Inventory is empty</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Add quest items, loot, or supplies to track here.
                  </p>
                </div>
              ) : (
                inventory.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-lg border bg-background/10 p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{item.name}</p>
                        {item.notes && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {item.notes}
                          </p>
                        )}
                      </div>
                      <Badge
                        variant="secondary"
                        className="rounded-full tabular-nums"
                      >
                        x{item.qty}
                      </Badge>
                    </div>
                  </div>
                ))
              )}
                </div>
              </ScrollArea>
            </TabsContent>
          </Tabs>

          {mode === "combat" && (
            <div className="mt-5 pt-4">
              <Separator />
              <div className="mb-4 mt-5 flex items-center gap-2 text-sm font-semibold tracking-wide">
                <Swords className="h-4 w-4" />
                Combat
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border bg-background/10 p-3">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                    <ListOrdered className="h-4 w-4 text-muted-foreground" />
                    Initiative
                  </div>
                  <div className="space-y-2">
                    {initiative.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        Initiative order will appear here.
                      </p>
                    ) : (
                      initiative.map((entry, idx) => (
                        <div
                          key={entry.id}
                          className={cn(
                            "flex items-center justify-between gap-3 rounded-md border px-2.5 py-2",
                            entry.id === currentTurnId
                              ? "border-ring/80 bg-secondary/60"
                              : "border-border/80"
                          )}
                        >
                          <p className="truncate text-sm">
                            {idx + 1}. {entry.name}
                          </p>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {entry.initiative}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="rounded-lg border bg-background/10 p-3">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                    <Swords className="h-4 w-4 text-muted-foreground" />
                    Enemies
                  </div>
                  <div className="space-y-2">
                    {enemies.length === 0 ? (
                      <p className="text-sm text-muted-foreground">No enemies yet.</p>
                    ) : (
                      enemies.map((enemy) => (
                        <div key={enemy.id} className="rounded-md border px-2.5 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <p className="truncate text-sm font-semibold">{enemy.name}</p>
                            <Badge
                              variant={severityTone[enemy.severity].variant}
                              className="rounded-full"
                            >
                              {enemy.severity}
                            </Badge>
                          </div>
                          {enemy.note && (
                            <p className="mt-1 text-xs text-muted-foreground">{enemy.note}</p>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
