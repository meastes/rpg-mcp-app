import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
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

function formatPercent(value: number, max: number) {
  if (!max || max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / max) * 100)));
}

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <Card className="border-white/10 bg-white/5 shadow-none">
      <CardContent className="pt-4">
        <Accordion
          type="single"
          collapsible
          defaultValue={defaultOpen ? "section" : undefined}
        >
          <AccordionItem value="section" className="border-none">
            <AccordionTrigger className="py-2 text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--muted)] hover:text-foreground">
              {title}
            </AccordionTrigger>
            <AccordionContent className="pt-2">{children}</AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
}

function StatBar({ label, current, max, tone }: { label: string; current: number; max: number; tone: "hp" | "mp" }) {
  const indicatorStyle =
    tone === "hp"
      ? { backgroundColor: "var(--destructive)" }
      : { backgroundColor: "var(--primary)" };
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
  const safeCurrent = Number.isFinite(current) ? current : 0;
  return (
    <Card className="border-white/10 bg-[color:var(--panel)]/90">
      <CardContent className="pt-4">
        <div className="flex items-center justify-between text-xs text-[color:var(--muted)]">
          <span>{label}</span>
          <span>
            {safeCurrent} / {safeMax}
          </span>
        </div>
        <Progress
          className="mt-3 bg-white/10"
          indicatorStyle={indicatorStyle}
          value={formatPercent(safeCurrent, safeMax)}
        />
      </CardContent>
    </Card>
  );
}

function PhaseBadge({ phase }: { phase: string }) {
  const toneMap: Record<string, "secondary" | "default" | "destructive"> = {
    setup: "secondary",
    exploration: "default",
    combat: "destructive",
  };

  const color = toneMap[phase] ?? "secondary";
  return <Badge variant={color}>{phase}</Badge>;
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
      <Card className="mx-auto flex min-h-[280px] w-full max-w-3xl flex-col items-center justify-center rounded-3xl border-white/10 bg-[color:var(--panel)]/80 p-8 text-center">
        <p className="text-sm text-[color:var(--muted)]">Waiting for game state.</p>
        <p className="mt-2 text-xs text-[color:var(--muted)]">
          Ask ChatGPT to start the adventure, then the widget will update automatically.
        </p>
      </Card>
    );
  }

  const storyElements = (game.storyElements ?? []).filter(Boolean);
  const inventory = game.inventory ?? [];
  const log = game.log ?? [];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <Card className="rounded-3xl border-white/10 bg-[color:var(--panel-strong)]/90 shadow-glow">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4 px-6 py-5">
          <div>
            <CardDescription className="text-xs uppercase tracking-[0.3em] text-[color:var(--muted)]">
              Game State
            </CardDescription>
            <CardTitle className="text-2xl">
              {game.pc?.name ? game.pc.name : "Unnamed hero"}
            </CardTitle>
            <CardDescription className="text-sm text-[color:var(--muted)]">
              {[game.genre, game.tone].filter(Boolean).join(" • ") || "Details incoming"}
            </CardDescription>
          </div>
          <PhaseBadge phase={game.phase} />
        </CardHeader>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-6">
          <Card className="rounded-3xl border-white/10 bg-[color:var(--panel)]/90 shadow-glow">
            <CardContent className="p-6">
            <div className="grid gap-4 md:grid-cols-2">
              {game.hp && <StatBar label="HP" current={game.hp.current} max={game.hp.max} tone="hp" />}
              {game.mp && game.mp.max > 0 && (
                <StatBar label="MP" current={game.mp.current} max={game.mp.max} tone="mp" />
              )}
            </div>

            <div className="mt-6 grid gap-3 md:grid-cols-2">
              <Section title="Location">
                <p className="text-sm">{game.location || "Unknown"}</p>
              </Section>
              <Section title="Stats">
                {game.stats ? (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <span>STR {game.stats.str}</span>
                    <span>AGI {game.stats.agi}</span>
                    <span>INT {game.stats.int}</span>
                    <span>CHA {game.stats.cha}</span>
                  </div>
                ) : (
                  <p className="text-sm text-[color:var(--muted)]">Stats pending.</p>
                )}
              </Section>
            </div>

            <div className="mt-6 grid gap-3">
              {(game.pc?.archetype || game.pc?.background) && (
                <Section title="Character">
                  <p className="text-sm">
                    {[game.pc?.archetype, game.pc?.background].filter(Boolean).join(" • ")}
                  </p>
                  {game.pc?.goal && (
                    <p className="mt-2 text-xs text-[color:var(--muted)]">Goal: {game.pc.goal}</p>
                  )}
                </Section>
              )}

              {storyElements.length > 0 && (
                <Section title="Story elements">
                  <ul className="grid gap-2 text-sm">
                    {storyElements.map((element, index) => (
                      <li key={`${element}-${index}`} className="rounded-xl bg-white/5 px-3 py-2">
                        {element}
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

            {game.lastRoll && (
              <Section title="Last roll">
                <p className="text-sm font-semibold">
                  {game.lastRoll.formula} = {game.lastRoll.total}
                </p>
                {game.lastRoll.reason && (
                  <p className="mt-1 text-xs text-[color:var(--muted)]">{game.lastRoll.reason}</p>
                )}
              </Section>
            )}
          </div>
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-6">
          {inventory.length > 0 && (
            <Section title="Inventory">
              <ul className="space-y-2 text-sm">
                {inventory.map((item) => (
                  <li key={item.id} className="rounded-xl bg-white/5 px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{item.name}</span>
                      <span className="text-xs text-[color:var(--muted)]">x{item.qty}</span>
                    </div>
                    {item.notes && (
                      <p className="mt-1 text-xs text-[color:var(--muted)]">{item.notes}</p>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {game.combat && (
            <Section title="Combat">
              <div className="space-y-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted)]">Enemy</p>
                  <p className="text-lg font-semibold">{game.combat.enemyName}</p>
                  {game.combat.enemyIntent && (
                    <p className="text-xs text-[color:var(--muted)]">{game.combat.enemyIntent}</p>
                  )}
                </div>
                <div className="rounded-xl bg-white/5 p-3">
                  <div className="flex items-center justify-between text-xs text-[color:var(--muted)]">
                    <span>Enemy HP</span>
                    <span>
                      {game.combat.enemyHp} / {game.combat.enemyHpMax}
                    </span>
                  </div>
                  <Progress
                    className="mt-2 bg-white/10"
                    indicatorStyle={{ backgroundColor: "var(--warning)" }}
                    value={formatPercent(game.combat.enemyHp, game.combat.enemyHpMax)}
                  />
                </div>
              </div>
            </Section>
          )}

          {log.length > 0 && (
            <Section title="Recent log" defaultOpen={false}>
              <ol className="space-y-2 text-sm">
                {log
                  .slice()
                  .reverse()
                  .slice(0, 6)
                  .map((entry) => (
                    <li key={entry.id} className="rounded-xl bg-white/5 px-3 py-2">
                      <p className="text-xs uppercase tracking-[0.2em] text-[color:var(--muted)]">
                        {entry.kind}
                      </p>
                      <p>{entry.text}</p>
                    </li>
                  ))}
              </ol>
            </Section>
          )}
        </aside>
      </div>
    </div>
  );
}
