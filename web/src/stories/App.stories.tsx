import type { Meta, StoryObj } from "@storybook/react";
import { useEffect } from "react";
import { App } from "../App";

const mockState = {
  type: "ttrpg_state",
  gameId: "game_demo",
  phase: "exploration",
  setupComplete: true,
  genre: "Sky noir",
  tone: "Hopeful",
  storyElements: ["Cursed lighthouse", "Rival crew", "Hidden map"],
  pc: {
    name: "Aster Vale",
    pronouns: "they/them",
    archetype: "Relic hunter",
    background: "Former guild envoy",
    goal: "Find the atlas of storms",
  },
  stats: { str: 2, agi: 3, int: 4, cha: 2 },
  hp: { current: 9, max: 12 },
  mp: { current: 4, max: 6 },
  inventory: [
    { id: "item_1", name: "Traveler's pack", qty: 1, notes: "Basic gear" },
    { id: "item_2", name: "Gleamstone", qty: 2, notes: "Crackling energy" },
  ],
  location: "Azure Docks",
  combat: null,
  lastRoll: { formula: "d20+2", total: 17, reason: "Stealth check" },
  log: [
    { id: "log_1", at: new Date().toISOString(), kind: "story", text: "A storm rolls in." },
    { id: "log_2", at: new Date().toISOString(), kind: "roll", text: "Rolled d20+2." },
  ],
};

type MockState = typeof mockState;

type WrapperProps = {
  state: MockState | null;
};

function StateWrapper({ state }: WrapperProps) {
  useEffect(() => {
    if (!window.openai) {
      window.openai = {};
    }
    window.openai.toolOutput = state;

    const event = new CustomEvent("openai:set_globals", {
      detail: { globals: { toolOutput: state } },
    });
    window.dispatchEvent(event);
  }, [state]);

  return <App />;
}

const meta: Meta<typeof StateWrapper> = {
  title: "Widget/App",
  component: StateWrapper,
  args: {
    state: mockState,
  },
};

export default meta;

type Story = StoryObj<typeof StateWrapper>;

export const Exploration: Story = {
  args: {
    state: mockState,
  },
};

export const Combat: Story = {
  args: {
    state: {
      ...mockState,
      phase: "combat",
      combat: {
        enemyName: "Void Drake",
        enemyHp: 14,
        enemyHpMax: 20,
        enemyIntent: "Unleash a shockwave",
        round: 2,
      },
    },
  },
};

export const NoInventory: Story = {
  args: {
    state: {
      ...mockState,
      inventory: [],
    },
  },
};

export const MinimalState: Story = {
  args: {
    state: {
      type: "ttrpg_state",
      gameId: "game_minimal",
      phase: "setup",
      setupComplete: false,
      genre: "",
      tone: "",
      storyElements: [],
      pc: { name: "", archetype: "" },
      stats: { str: 2, agi: 2, int: 2, cha: 2 },
      hp: { current: 10, max: 12 },
      mp: { current: 0, max: 0 },
      inventory: [],
      location: "",
      combat: null,
      lastRoll: null,
      log: [],
    },
  },
};

export const Empty: Story = {
  args: {
    state: null,
  },
};
