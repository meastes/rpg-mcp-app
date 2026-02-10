import test from "node:test";
import assert from "node:assert/strict";

import {
  applySetupDefaults,
  beginSetupSession,
  confirmSetupSession,
  consumeConfirmedSetupSession,
  getRequiredSetupChoices,
  invalidSetupChoices,
  isCompleteStatsObject,
  mergeSetupArgs,
  missingSetupChoices,
} from "../mcp/setup-flow.js";

const VALID_STATS = {
  str: 15,
  agi: 14,
  con: 13,
  int: 12,
  wis: 10,
  cha: 8,
};

test("mergeSetupArgs merges nested pc fields", () => {
  const merged = mergeSetupArgs(
    { genre: "Mystery", pc: { name: "Iris", archetype: "Scout" } },
    { tone: "Gritty", pc: { background: "Exile" } }
  );

  assert.deepEqual(merged, {
    genre: "Mystery",
    tone: "Gritty",
    pc: {
      name: "Iris",
      archetype: "Scout",
      background: "Exile",
    },
  });
});

test("isCompleteStatsObject validates required stat keys", () => {
  assert.equal(isCompleteStatsObject(VALID_STATS), true);
  assert.equal(isCompleteStatsObject({ ...VALID_STATS, cha: undefined }), false);
  assert.equal(isCompleteStatsObject(null), false);
});

test("required and missing choices differ by guided vs auto mode", () => {
  assert.deepEqual(getRequiredSetupChoices("guided"), [
    "genre",
    "pc.name",
    "pc.archetype",
    "startingLocation",
    "stats",
  ]);
  assert.deepEqual(getRequiredSetupChoices("auto"), [
    "genre",
    "pc.name",
    "pc.archetype",
    "startingLocation",
  ]);

  const missingGuided = missingSetupChoices(
    { genre: "Adventure", pc: { name: "Rowan" }, startingLocation: "" },
    "guided"
  );
  assert.deepEqual(missingGuided.sort(), ["pc.archetype", "startingLocation", "stats"].sort());

  const missingAuto = missingSetupChoices(
    { genre: "Adventure", pc: { name: "Rowan" }, startingLocation: "" },
    "auto"
  );
  assert.deepEqual(missingAuto.sort(), ["pc.archetype", "startingLocation"].sort());
});

test("invalidSetupChoices enforces guided stat range and integer constraints", () => {
  assert.deepEqual(invalidSetupChoices({ stats: VALID_STATS }, "guided"), []);
  assert.deepEqual(
    invalidSetupChoices(
      {
        stats: { ...VALID_STATS, str: 16.5 },
      },
      "guided"
    ),
    ["stats"]
  );
  assert.deepEqual(
    invalidSetupChoices(
      {
        stats: { ...VALID_STATS, str: 20 },
      },
      "guided"
    ),
    ["stats"]
  );
  assert.deepEqual(invalidSetupChoices({ stats: { ...VALID_STATS, str: 20 } }, "auto"), []);
});

test("applySetupDefaults fills required fields", () => {
  const defaults = applySetupDefaults({});

  assert.ok(defaults.genre);
  assert.ok(defaults.tone);
  assert.ok(defaults.startingLocation);
  assert.ok(defaults.pc?.name);
  assert.ok(defaults.pc?.archetype);
});

test("setup session flow confirms and consumes once", () => {
  const session = beginSetupSession("game_test_1", {
    genre: "Adventure",
    pc: { name: "Rowan" },
  }, "guided");

  const firstConfirm = confirmSetupSession(session.setupId, {
    pc: { archetype: "Scholar" },
    startingLocation: "Old Harbor Market",
    stats: VALID_STATS,
  });
  assert.equal(firstConfirm.ok, true);

  const wrongGame = consumeConfirmedSetupSession(session.setupId, "other_game");
  assert.equal(wrongGame.ok, false);
  assert.match(wrongGame.message, /does not match gameId/i);

  const consumed = consumeConfirmedSetupSession(session.setupId, "game_test_1");
  assert.equal(consumed.ok, true);
  assert.equal(consumed.gameId, "game_test_1");
  assert.deepEqual(consumed.startArgs.stats, VALID_STATS);

  const consumedAgain = consumeConfirmedSetupSession(session.setupId, "game_test_1");
  assert.equal(consumedAgain.ok, false);
  assert.match(consumedAgain.message, /not found or expired/i);
});

test("expired session is purged before confirm", () => {
  const session = beginSetupSession("game_test_2", {}, "guided");
  session.expiresAt = Date.now() - 1;

  const result = confirmSetupSession(session.setupId, {
    genre: "Adventure",
    pc: { name: "Kestrel", archetype: "Guardian" },
    startingLocation: "Ashwind Rail Yard",
    stats: VALID_STATS,
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /not found or expired/i);
});
