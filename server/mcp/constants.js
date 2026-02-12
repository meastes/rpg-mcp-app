export const TOOL_OUTPUT_TEMPLATE = "ui://widget/rpg.html";
export const commonToolMeta = {
  "openai/outputTemplate": TOOL_OUTPUT_TEMPLATE,
};
export const GAME_GUIDE_RESOURCE = "rpg://guide";
export const SETUP_SESSION_TTL_MS = 30 * 60 * 1000;
export const BASE_REQUIRED_SETUP_CHOICES = [
  "genre",
  "pc.name",
  "pc.archetype",
  "startingLocation",
];
export const GUIDED_ONLY_REQUIRED_SETUP_CHOICES = ["stats"];
export const GAME_GUIDE_SUMMARY =
  "Read the guide, pick genre/tone, starting location, and core character details, then confirm setup before starting.";
export const DEFAULT_GENRES = [
  "Adventure",
  "Mystery",
  "Science Fiction",
];
export const DEFAULT_TONES = ["Cinematic", "Grounded", "Gritty"];
export const DEFAULT_ARCHETYPES = ["Specialist", "Guardian", "Scout", "Scholar", "Wildcard"];
export const DEFAULT_PC_NAMES = ["Rowan", "Kestrel", "Iris", "Thorn", "Ash"];
export const DEFAULT_STARTING_LOCATIONS = [
  "The Rusted Causeway",
  "Old Harbor Market",
  "Sunken Observatory",
  "Ashwind Rail Yard",
  "Glass Dunes Outpost",
];
export const GAME_GUIDE_TEXT = `TTRPG Game Guide (general, system-agnostic)

Core loop:
- Present a scene and a clear choice.
- Ask for intent and approach.
- Resolve with a roll when failure is interesting or time matters.
- Describe the outcome and update state.

Running a session:
- Start with a hook, a goal, and a constraint.
- Track stakes: what happens on success, partial, or failure.
- Keep the pace by alternating spotlight between players.
- Use short, concrete descriptions; ask questions to fill in details.

Encounters:
- Make enemies intelligible: name, intent, and a tell.
- Use the environment (cover, hazards, objectives) to vary tactics.
- End fights when the story shifts: surrender, retreat, or twist.

Stats & leveling (D&D 5e style, not enforced):
- Starting stats: standard array 15,14,13,12,10,8 or 27-point buy (8-15 pre-bonuses).
- Primary stat: aim for 14-16 after ancestry/background bonuses.
- Ability increases at levels 4,8,12,16,19: +2 one stat or +1/+1, max 20.
- Optional: proficiency bonus +2 at level 1; +3 at 5; +4 at 9; +5 at 13; +6 at 17.

Rewards and progression:
- Reward what you want to see: risk, creativity, teamwork.
- Give tangible progress: clues, allies, reputation, or gear.

Safety and consent:
- Confirm boundaries; allow players to skip content without explanation.
- Keep a quick stop/slow/swap option available.

Remember: these are guidelines. Adjust to fit your table.`;

export const STAT_KEYS = Object.freeze(["str", "agi", "con", "int", "wis", "cha"]);
export const STANDARD_ARRAY = Object.freeze([15, 14, 13, 12, 10, 8]);
export const baseStats = Object.freeze({
  str: 15,
  agi: 14,
  con: 13,
  int: 12,
  wis: 10,
  cha: 8,
});
export const DEFAULT_MELEE_RANGE = 1;
export const DEFAULT_MOVE_SPEED = 6;
export const MAX_RANGE = 30;
export const MAX_LEVEL = 20;
export const COMBAT_ACTIONS_REQUIRING_ACTION = new Set([
  "attack",
  "defend",
  "dodge",
  "use_skill",
]);
export const UNARMED_WEAPON_ID = "weapon_unarmed";
export const UNARMED_WEAPON = Object.freeze({
  id: UNARMED_WEAPON_ID,
  name: "Default Melee",
  category: "melee",
  range: DEFAULT_MELEE_RANGE,
  equipped: true,
  damageFormula: "1",
});
export const DEFAULT_ENEMY_WEAPON = Object.freeze({
  id: "weapon_enemy_basic",
  name: "Basic Weapon",
  category: "melee",
  range: DEFAULT_MELEE_RANGE,
  equipped: true,
  damageFormula: "1d6",
});
