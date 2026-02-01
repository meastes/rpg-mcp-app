import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Progress } from "@/components/ui/progress";
import {
  Backpack,
  BarChart3,
  Heart,
  Activity,
  ListOrdered,
  Sparkles,
  Swords,
} from "lucide-react";

const SET_GLOBALS_EVENT = "openai:set_globals";

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
  enemyName: string;
  enemyHp: number;
  enemyHpMax: number;
  enemyIntent?: string;
  round?: number;
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
  stats?: { str: number; agi: number; int: number; cha: number };
  hp?: { current: number; max: number };
  mp?: { current: number; max: number };
  inventory?: InventoryItem[];
  location?: string;
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

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const headerContent = (
    <>
      <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl border bg-background/60">
        {icon}
      </div>
      <div className="min-w-0">
        <CardTitle className="text-base leading-tight">{title}</CardTitle>
      </div>
    </>
  );
  return (
    <Card className="rounded-2xl shadow-sm">
      <CardHeader className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3 transition-colors hover:text-foreground">
            {headerContent}
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">{children}</CardContent>
    </Card>
  );
}

function AccordionSection({
  title,
  icon,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <Card className="rounded-2xl shadow-sm">
      <Accordion
        type="single"
        collapsible
        defaultValue={defaultOpen ? "section" : undefined}
        className="w-full"
      >
        <AccordionItem value="section" className="border-none">
          <CardHeader className="space-y-2">
            <AccordionTrigger className="py-0 hover:no-underline cursor-pointer">
              <div className="flex w-full items-center justify-between gap-3 text-left">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl border bg-background/60">
                    {icon}
                  </div>
                  <div className="min-w-0">
                    <CardTitle className="text-base leading-tight">
                      {title}
                    </CardTitle>
                  </div>
                </div>
              </div>
            </AccordionTrigger>
          </CardHeader>
          <CardContent className="pt-0">
            <AccordionContent className="pt-0">
              {children}
            </AccordionContent>
          </CardContent>
        </AccordionItem>
      </Accordion>
    </Card>
  );
}

function Meter({
  label,
  icon,
  value,
  max,
  tone,
}: {
  label: string;
  icon: ReactNode;
  value: number;
  max: number;
  tone: "hp" | "mp";
}) {
  const safeMax = Math.max(0, max);
  const safeValue = clamp(value, 0, safeMax);
  const pct = safeMax > 0 ? Math.round((safeValue / safeMax) * 100) : 0;
  const indicatorStyle =
    tone === "hp"
      ? { backgroundColor: "var(--destructive)" }
      : { backgroundColor: "var(--primary)" };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border bg-background/60">
            {icon}
          </span>
          <span className="truncate">{label}</span>
        </div>
        <div className="text-sm tabular-nums">
          <span className="font-semibold">{safeValue}</span>
          <span className="text-muted-foreground">/{safeMax}</span>
        </div>
      </div>
      <Progress
        value={pct}
        className="h-2 rounded-full"
        indicatorStyle={indicatorStyle}
      />
    </div>
  );
}

function formatStatValue(value?: number) {
  if (value === undefined || value === null || Number.isNaN(value)) return "--";
  return value;
}

function getSeverityFromPercent(percent: number): EnemySeverity {
  if (percent <= 0) return "Down";
  if (percent <= 15) return "Critical";
  if (percent <= 35) return "Badly Wounded";
  if (percent <= 60) return "Wounded";
  if (percent <= 85) return "Scratched";
  return "Unhurt";
}

export function App() {
  const toolOutput = useToolOutput();
  const game = useMemo(() => {
    if (toolOutput && "type" in toolOutput && toolOutput.type === "ttrpg_state") {
      return toolOutput as GameState;
    }
    return null;
  }, [toolOutput]);

  if (!game) {
    return (
      <div className="mx-auto w-full max-w-[440px] p-3 sm:p-4">
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="py-8 text-center">
            <p className="text-sm text-muted-foreground">Waiting for game state.</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Ask ChatGPT to start the adventure, then the widget will update automatically.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const inventory = game.inventory ?? [];
  const mode: GameMode = game.phase === "combat" ? "combat" : "explore";
  const characterName = game.pc?.name ?? "Unnamed hero";

  const hpMax = game.hp?.max ?? 0;
  const hp = game.hp?.current ?? 0;
  const mpMax = game.mp?.max ?? 0;
  const mp = game.mp?.current ?? 0;

  const stats: Record<StatKey, number | undefined> = {
    STR: game.stats?.str,
    DEX: game.stats?.agi,
    CON: undefined,
    INT: game.stats?.int,
    WIS: undefined,
    CHA: game.stats?.cha,
  };

  const enemies: Enemy[] = game.combat
    ? [
        {
          id: "enemy-1",
          name: game.combat.enemyName || "Unknown foe",
          severity: getSeverityFromPercent(
            game.combat.enemyHpMax > 0
              ? Math.round((game.combat.enemyHp / game.combat.enemyHpMax) * 100)
              : 0
          ),
          note: game.combat.enemyIntent,
        },
      ]
    : [];

  const statusChip =
    mode === "combat"
      ? { label: "Combat", icon: <Swords className="h-4 w-4" />, accent: "outline" }
      : {
          label: "Exploration",
          icon: <BarChart3 className="h-4 w-4" />,
          accent: "secondary",
        };

  return (
    <div className="mx-auto w-full max-w-2xl p-3 sm:p-4">
      <div className="space-y-3">
        <Card className="rounded-2xl shadow-sm">
          <CardContent className="pt-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h1
                  className="font-semibold leading-tight tracking-tight truncate"
                  style={{ fontSize: "clamp(1.5rem, 3.2vw, 2.25rem)" }}
                >
                  {characterName}
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  {game.location ? `Location: ${game.location}` : "Character session tracker"}
                </p>
              </div>
              <div className="flex flex-col items-end gap-3">
                <Badge variant={statusChip.accent as "secondary" | "outline"} className="rounded-full">
                  <span className="inline-flex items-center gap-1.5">
                    {statusChip.icon}
                    {statusChip.label}
                  </span>
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        <Section title="Resources" icon={<Activity className="h-4 w-4" />}>
          <div className="space-y-4">
            <Meter
              label="HP"
              icon={<Heart className="h-4 w-4" />}
              value={hp}
              max={hpMax}
              tone="hp"
            />
            {mpMax > 0 && (
              <Meter
                label="MP"
                icon={<Sparkles className="h-4 w-4" />}
                value={mp}
                max={mpMax}
                tone="mp"
              />
            )}
          </div>
        </Section>

        <AccordionSection
          title="Stats"
          icon={<BarChart3 className="h-4 w-4" />}
          defaultOpen
        >
          <div className="grid grid-cols-[repeat(auto-fit,minmax(90px,1fr))] gap-1.5">
            {(Object.keys(stats) as StatKey[]).map((key) => (
              <div
                key={key}
                className="flex items-center justify-between gap-2 rounded-full border px-3 py-1.5 text-sm font-medium"
              >
                <span className="text-muted-foreground">{key}</span>
                <span className="tabular-nums">{formatStatValue(stats[key])}</span>
              </div>
            ))}
          </div>
        </AccordionSection>

        <AccordionSection
          title="Inventory"
          icon={<Backpack className="h-4 w-4" />}
          defaultOpen={false}
        >
          <div className="space-y-2">
            {inventory.length === 0 ? (
              <p className="text-sm text-muted-foreground">Inventory is empty.</p>
            ) : (
              inventory.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start justify-between gap-3 rounded-2xl border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.name}</p>
                    {item.notes && (
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                        {item.notes}
                      </p>
                    )}
                  </div>
                  <Badge variant="secondary" className="rounded-full tabular-nums">
                    x{item.qty}
                  </Badge>
                </div>
              ))
            )}
          </div>
        </AccordionSection>

        {mode === "combat" && (
          <div className="space-y-3">
            <AccordionSection
              title="Initiative"
              icon={<ListOrdered className="h-4 w-4" />}
              defaultOpen
            >
              <div className="space-y-2">
                <div className="rounded-2xl border p-3 text-sm text-muted-foreground">
                  Initiative order will appear here.
                </div>
              </div>
            </AccordionSection>

            <AccordionSection
              title="Combat tracker"
              icon={<Swords className="h-4 w-4" />}
              defaultOpen
            >
              <div className="space-y-2">
                {enemies.length === 0 ? (
                  <div className="rounded-2xl border p-3 text-sm text-muted-foreground">
                    No enemies yet.
                  </div>
                ) : (
                  enemies.map((enemy) => (
                    <div key={enemy.id} className="rounded-2xl border p-3">
                      <p className="text-sm font-semibold">{enemy.name}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <Badge
                          variant={severityTone[enemy.severity].variant}
                          className="rounded-full"
                        >
                          {enemy.severity}
                        </Badge>
                        {enemy.note && (
                          <span className="text-xs text-muted-foreground">{enemy.note}</span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </AccordionSection>
          </div>
        )}
      </div>
    </div>
  );
}
