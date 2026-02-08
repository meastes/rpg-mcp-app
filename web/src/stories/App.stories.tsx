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
  stats: { str: 15, agi: 14, con: 13, int: 12, wis: 10, cha: 8 },
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
type MockImageRequest = {
  type?: string;
  gameId?: string;
  trigger?: string;
  location?: string;
  prompt?: string;
  requestedAt?: string;
} | null;

type StoryState = MockState & {
  imageRequest?: MockImageRequest;
};

type WrapperProps = {
  state: StoryState | null;
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
    state: {
      ...mockState,
      imageRequest: {
        type: "location_image",
        gameId: mockState.gameId,
        trigger: "location_update",
        location: mockState.location,
        prompt:
          "A cinematic fantasy harbor at dusk, brass lanterns reflecting in wet cobblestones, storm clouds gathering over distant ships.",
        requestedAt: "2026-02-08T10:00:00.000Z",
      },
    },
  },
};

export const Combat: Story = {
  args: {
    state: {
      ...mockState,
      phase: "combat",
      combat: {
        round: 2,
        currentTurnId: "init_1",
        enemies: [
          {
            id: "enemy_1",
            name: "Void Drake",
            hp: 14,
            hpMax: 20,
            status: "Wounded",
            intent: "Unleash a shockwave",
          },
          {
            id: "enemy_2",
            name: "Drakeling",
            hp: 6,
            hpMax: 10,
            status: "Scratched",
            intent: "Flank the party",
          },
        ],
        initiative: [
          { id: "init_1", name: "Aster Vale", kind: "pc", initiative: 17 },
          { id: "init_2", name: "Void Drake", kind: "enemy", initiative: 15 },
          { id: "init_3", name: "Drakeling", kind: "enemy", initiative: 11 },
        ],
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
      stats: { str: 10, agi: 10, con: 10, int: 10, wis: 10, cha: 10 },
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
