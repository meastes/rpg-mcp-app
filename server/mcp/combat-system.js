import crypto from "node:crypto";
import {
  COMBAT_ACTIONS_REQUIRING_ACTION,
  DEFAULT_ENEMY_WEAPON,
  DEFAULT_MELEE_RANGE,
  DEFAULT_MOVE_SPEED,
  MAX_LEVEL,
  MAX_RANGE,
  UNARMED_WEAPON,
  UNARMED_WEAPON_ID,
} from "./constants.js";
import { clamp, rollDice } from "./core-utils.js";
import {
  ensureSingleEquippedWeapon,
  getInventoryWeapons,
  getSkillCatalog,
  normalizeSkill,
  normalizeWeapon,
} from "./player-data.js";

function getEnemyStatus(hp, hpMax) {
  const safeMax = Number.isFinite(hpMax) && hpMax > 0 ? hpMax : 0;
  const safeHp = Number.isFinite(hp) ? hp : 0;
  if (!safeMax) return "Unhurt";
  const pct = (safeHp / safeMax) * 100;
  if (pct <= 0) return "Down";
  if (pct <= 15) return "Critical";
  if (pct <= 35) return "Badly Wounded";
  if (pct <= 60) return "Wounded";
  if (pct <= 85) return "Scratched";
  return "Unhurt";
}

function getCombatantSpeed(combatant) {
  return clamp(Number(combatant?.speed ?? DEFAULT_MOVE_SPEED), 0, MAX_RANGE);
}

function buildPcCombatant(game, existingPc = {}, patch = {}) {
  const safeLevel = clamp(
    Number(patch.level ?? game.pc?.level ?? existingPc.level ?? 1),
    1,
    MAX_LEVEL
  );
  const baseWeapons = getInventoryWeapons(game.inventory);
  const hasUnarmed = baseWeapons.some((weapon) => weapon.id === UNARMED_WEAPON_ID);
  const weapons = ensureSingleEquippedWeapon(
    hasUnarmed ? baseWeapons : [...baseWeapons, { ...UNARMED_WEAPON }],
    patch.equippedWeaponId ?? existingPc.equippedWeaponId
  );
  const equippedWeaponId = weapons.find((weapon) => weapon.equipped)?.id ?? UNARMED_WEAPON_ID;
  const skillCatalog = getSkillCatalog(
    safeLevel,
    patch.skills ?? game.pc?.skills ?? existingPc.skills
  );
  const speed = clamp(Number(patch.speed ?? existingPc.speed ?? DEFAULT_MOVE_SPEED), 0, MAX_RANGE);
  const hpMax = clamp(Number(game.hp?.max ?? patch.hpMax ?? existingPc.hpMax ?? 12), 1, 999);
  const mpMax = clamp(Number(game.mp?.max ?? patch.mpMax ?? existingPc.mpMax ?? 0), 0, 999);
  return {
    id: existingPc.id ?? `pc_${game.gameId}`,
    name: game.pc?.name || existingPc.name || "Player",
    hpMax,
    hp: clamp(Number(patch.hp ?? existingPc.hp ?? game.hp?.current ?? hpMax), 0, hpMax),
    mpMax,
    mp: clamp(Number(patch.mp ?? existingPc.mp ?? game.mp?.current ?? mpMax), 0, mpMax),
    level: safeLevel,
    position: clamp(Number(patch.position ?? existingPc.position ?? 0), 0, 100),
    speed,
    movementRemaining: clamp(
      Number(patch.movementRemaining ?? existingPc.movementRemaining ?? speed),
      0,
      speed
    ),
    actionUsed: Boolean(patch.actionUsed ?? existingPc.actionUsed ?? false),
    defending: Boolean(patch.defending ?? existingPc.defending ?? false),
    dodging: Boolean(patch.dodging ?? existingPc.dodging ?? false),
    weapons,
    equippedWeaponId,
    skills: skillCatalog.allSkills,
  };
}

function buildEnemyCombatant(enemy, existingEnemy = {}, index = 0) {
  if (!enemy?.name && !existingEnemy?.name) return null;
  const hpMax = clamp(Number(enemy?.hpMax ?? existingEnemy?.hpMax ?? 10), 1, 999);
  const hp = clamp(Number(enemy?.hp ?? existingEnemy?.hp ?? hpMax), 0, hpMax);
  const safeLevel = clamp(Number(enemy?.level ?? existingEnemy?.level ?? 1), 1, MAX_LEVEL);
  const sourceWeapons = Array.isArray(enemy?.weapons)
    ? enemy.weapons
    : Array.isArray(existingEnemy?.weapons)
      ? existingEnemy.weapons
      : [];
  const normalizedWeapons = sourceWeapons
    .map((weapon, weaponIndex) =>
      normalizeWeapon(
        weapon,
        weapon?.name ?? `${enemy?.name ?? existingEnemy?.name} weapon ${weaponIndex + 1}`,
        "weapon_enemy"
      )
    )
    .filter(Boolean);
  const withDefaultWeapon =
    normalizedWeapons.length > 0 ? normalizedWeapons : [{ ...DEFAULT_ENEMY_WEAPON }];
  const weapons = ensureSingleEquippedWeapon(
    withDefaultWeapon,
    enemy?.equippedWeaponId ?? existingEnemy?.equippedWeaponId
  );
  const equippedWeaponId = weapons.find((weapon) => weapon.equipped)?.id ?? weapons[0].id;
  const rawSkills = Array.isArray(enemy?.skills)
    ? enemy.skills
    : Array.isArray(existingEnemy?.skills)
      ? existingEnemy.skills
      : [];
  const skills = rawSkills
    .map((skill, skillIndex) =>
      normalizeSkill(skill, skill?.name ?? `Skill ${skillIndex + 1}`, "skill_enemy")
    )
    .filter(Boolean);
  const speed = clamp(
    Number(enemy?.speed ?? existingEnemy?.speed ?? DEFAULT_MOVE_SPEED),
    0,
    MAX_RANGE
  );
  return {
    id: enemy?.id ?? existingEnemy?.id ?? `enemy_${crypto.randomUUID()}`,
    name: enemy?.name ?? existingEnemy?.name ?? `Enemy ${index + 1}`,
    hp,
    hpMax,
    mp: clamp(Number(enemy?.mp ?? existingEnemy?.mp ?? 0), 0, 999),
    mpMax: clamp(Number(enemy?.mpMax ?? existingEnemy?.mpMax ?? 0), 0, 999),
    status: enemy?.status ?? existingEnemy?.status ?? getEnemyStatus(hp, hpMax),
    intent: enemy?.intent ?? existingEnemy?.intent ?? "",
    note: enemy?.note ?? existingEnemy?.note ?? "",
    level: safeLevel,
    position: clamp(Number(enemy?.position ?? existingEnemy?.position ?? DEFAULT_MELEE_RANGE), 0, 100),
    speed,
    movementRemaining: clamp(
      Number(enemy?.movementRemaining ?? existingEnemy?.movementRemaining ?? speed),
      0,
      speed
    ),
    actionUsed: Boolean(enemy?.actionUsed ?? existingEnemy?.actionUsed ?? false),
    defending: Boolean(enemy?.defending ?? existingEnemy?.defending ?? false),
    dodging: Boolean(enemy?.dodging ?? existingEnemy?.dodging ?? false),
    weapons,
    equippedWeaponId,
    skills,
  };
}

function isCombatantAlive(combatant) {
  return Number(combatant?.hp ?? 0) > 0;
}

function getCombatantRef(combat, combatantId) {
  if (!combat || !combatantId) return null;
  if (combat.pc?.id === combatantId) {
    return { kind: "pc", combatant: combat.pc };
  }
  const enemy = Array.isArray(combat.enemies)
    ? combat.enemies.find((entry) => entry.id === combatantId)
    : null;
  if (!enemy) return null;
  return { kind: "enemy", combatant: enemy };
}

function distanceBetweenCombatants(source, target) {
  return Math.abs(Number(source?.position ?? 0) - Number(target?.position ?? 0));
}

function getWeaponFromCombatant(combatant, requestedWeaponId) {
  const weapons = ensureSingleEquippedWeapon(
    Array.isArray(combatant?.weapons) ? combatant.weapons : [],
    combatant?.equippedWeaponId
  );
  combatant.weapons = weapons;
  combatant.equippedWeaponId = weapons.find((weapon) => weapon.equipped)?.id ?? null;
  if (weapons.length === 0) return null;
  const selectedId = requestedWeaponId ?? combatant.equippedWeaponId;
  const weapon = weapons.find((entry) => entry.id === selectedId && entry.equipped);
  return weapon ?? null;
}

function getUsableSkill(combatant, skillId) {
  if (!skillId) return null;
  const level = clamp(Number(combatant?.level ?? 1), 1, MAX_LEVEL);
  const skills = Array.isArray(combatant?.skills) ? combatant.skills : [];
  return (
    skills.find((skill) => skill.id === skillId && Number(skill.unlockLevel ?? 1) <= level) ??
    null
  );
}

function ensureCombatTurnState(combatant) {
  const speed = getCombatantSpeed(combatant);
  combatant.speed = speed;
  combatant.movementRemaining = clamp(
    Number(combatant.movementRemaining ?? speed),
    0,
    speed
  );
  combatant.actionUsed = Boolean(combatant.actionUsed);
}

function applyDamage(combatant, amount) {
  const safeAmount = clamp(Number(amount ?? 0), 0, 999);
  if (!safeAmount) return 0;
  const before = combatant.hp;
  combatant.hp = clamp(Number(combatant.hp ?? 0) - safeAmount, 0, combatant.hpMax);
  return before - combatant.hp;
}

function applyHealing(combatant, amount) {
  const safeAmount = clamp(Number(amount ?? 0), 0, 999);
  if (!safeAmount) return 0;
  const before = combatant.hp;
  combatant.hp = clamp(Number(combatant.hp ?? 0) + safeAmount, 0, combatant.hpMax);
  return combatant.hp - before;
}

function resolveCombatAmount({ explicitAmount, formula, fallback = 0 }) {
  if (explicitAmount !== undefined) {
    return {
      amount: clamp(Number(explicitAmount), 0, 999),
      roll: null,
      source: "explicit",
    };
  }
  if (formula) {
    const roll = rollDice(formula);
    if (roll) {
      return {
        amount: clamp(Number(roll.total), 0, 999),
        roll,
        source: "rolled",
      };
    }
  }
  return {
    amount: clamp(Number(fallback), 0, 999),
    roll: null,
    source: "fallback",
  };
}

function rollInitiativeScore() {
  const roll = rollDice("d20");
  if (roll) return roll.total;
  return crypto.randomInt(1, 21);
}

function normalizeInitiativeScore(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function applyInitiativeScores(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const normalized = entries.map((entry) => ({
    ...entry,
    initiative: normalizeInitiativeScore(entry?.initiative),
  }));
  const allZero =
    normalized.length > 0 &&
    normalized.every((entry) => Number(entry.initiative ?? 0) === 0);
  const hasMissing = normalized.some((entry) => entry.initiative === null);
  if (!allZero && !hasMissing) {
    return normalized.map((entry) => ({
      ...entry,
      initiative: Number(entry.initiative),
    }));
  }
  return normalized.map((entry) => ({
    ...entry,
    initiative: rollInitiativeScore(),
  }));
}

function getWeaponRange(weapon) {
  if (!weapon) return 0;
  if (weapon.category === "melee") return DEFAULT_MELEE_RANGE;
  return clamp(Number(weapon.range ?? 1), 1, MAX_RANGE);
}

function moveCombatantToward(source, target, desiredDistance = 0) {
  const currentDistance = distanceBetweenCombatants(source, target);
  const maxMove = clamp(Number(source.movementRemaining ?? 0), 0, MAX_RANGE);
  const requiredMove = clamp(currentDistance - desiredDistance, 0, MAX_RANGE);
  const actualMove = clamp(Math.min(requiredMove, maxMove), 0, MAX_RANGE);
  if (actualMove <= 0) return 0;

  const direction = Number(target.position ?? 0) >= Number(source.position ?? 0) ? 1 : -1;
  const nextPosition = clamp(Number(source.position ?? 0) + direction * actualMove, 0, 100);
  const traveled = Math.abs(nextPosition - Number(source.position ?? 0));
  source.position = nextPosition;
  source.movementRemaining = clamp(maxMove - traveled, 0, source.speed);
  return traveled;
}

export function createCombatSystem({ addLog }) {
  function syncCombatState(game) {
    if (!game?.combat) return;
    const combat = game.combat;
    combat.round = clamp(Number(combat.round ?? 1), 1, 999);
    combat.pc = buildPcCombatant(game, combat.pc);
    combat.enemies = (Array.isArray(combat.enemies) ? combat.enemies : [])
      .map((enemy, index) => buildEnemyCombatant(enemy, enemy, index))
      .filter(Boolean);
    combat.enemies.forEach((enemy) => {
      enemy.status = getEnemyStatus(enemy.hp, enemy.hpMax);
      ensureCombatTurnState(enemy);
    });
    ensureCombatTurnState(combat.pc);
    combat.pc.hp = clamp(combat.pc.hp, 0, combat.pc.hpMax);
    combat.pc.mp = clamp(combat.pc.mp, 0, combat.pc.mpMax);
    game.hp.current = clamp(combat.pc.hp, 0, game.hp.max);
    game.mp.current = clamp(combat.pc.mp, 0, game.mp.max);
    game.pc.level = clamp(Number(combat.pc.level ?? game.pc.level ?? 1), 1, MAX_LEVEL);
    game.pc.skills = Array.isArray(combat.pc.skills)
      ? combat.pc.skills.map((skill) => normalizeSkill(skill, skill?.name, "skill")).filter(Boolean)
      : [];

    const fallbackInitiative = [
      { id: combat.pc.id, name: combat.pc.name, kind: "pc" },
      ...combat.enemies.map((enemy) => ({
        id: enemy.id,
        name: enemy.name,
        kind: "enemy",
      })),
    ];
    const candidateInitiative = Array.isArray(combat.initiative)
      ? combat.initiative
      : fallbackInitiative;
    const seen = new Set();
    const normalizedInitiative = candidateInitiative
      .map((entry) => {
        if (!entry?.id || seen.has(entry.id)) return null;
        const ref = getCombatantRef(combat, entry.id);
        if (!ref) return null;
        seen.add(entry.id);
        return {
          id: entry.id,
          name: ref.combatant.name,
          kind: ref.kind,
          initiative: normalizeInitiativeScore(entry.initiative),
        };
      })
      .filter(Boolean);

    const requiredEntries = [combat.pc, ...combat.enemies];
    requiredEntries.forEach((combatant) => {
      if (!seen.has(combatant.id)) {
        normalizedInitiative.push({
          id: combatant.id,
          name: combatant.name,
          kind: combat.pc.id === combatant.id ? "pc" : "enemy",
        });
      }
    });

    const withScores = applyInitiativeScores(normalizedInitiative);
    combat.initiative = withScores.sort((a, b) => b.initiative - a.initiative);
    const aliveTurnEntry = combat.initiative.find((entry) =>
      isCombatantAlive(getCombatantRef(combat, entry.id)?.combatant)
    );
    const currentTurnIsValid = combat.initiative.some(
      (entry) => entry.id === combat.currentTurnId
    );
    if (!currentTurnIsValid) {
      combat.currentTurnId = aliveTurnEntry?.id ?? combat.initiative[0]?.id ?? null;
    }

    const currentActorRef = getCombatantRef(combat, combat.currentTurnId);
    const currentActor = currentActorRef?.combatant ?? null;
    const currentSkills = currentActor
      ? getSkillCatalog(currentActor.level, currentActor.skills).unlockedSkills
      : [];
    combat.rules = {
      meleeRange: DEFAULT_MELEE_RANGE,
      actionTypes: ["attack", "defend", "dodge", "use_skill"],
      moveIsFree: true,
      oneActionPerTurn: true,
    };
    combat.turn = currentActor
      ? {
          actorId: currentActor.id,
          actorName: currentActor.name,
          kind: currentActorRef.kind,
          actionUsed: Boolean(currentActor.actionUsed),
          movementRemaining: Number(currentActor.movementRemaining ?? 0),
          equippedWeaponId: currentActor.equippedWeaponId ?? null,
          availableSkillIds: currentSkills.map((skill) => skill.id),
        }
      : null;
  }

  function resolveCombatOutcome(game) {
    if (!game?.combat) return null;
    const pcAlive = isCombatantAlive(game.combat.pc);
    const enemiesAlive = game.combat.enemies.some((enemy) => isCombatantAlive(enemy));
    if (!pcAlive) {
      game.combat = null;
      game.phase = "exploration";
      addLog(game, "Combat ended. The player is down.", "combat");
      return "player_down";
    }
    if (!enemiesAlive) {
      game.combat = null;
      game.phase = "exploration";
      addLog(game, "Combat ended. All enemies are down.", "combat");
      return "victory";
    }
    return null;
  }

  function advanceCombatTurn(game) {
    if (!game?.combat || !Array.isArray(game.combat.initiative) || game.combat.initiative.length === 0) {
      return { ok: false, message: "Initiative order is missing." };
    }
    const combat = game.combat;
    const currentIndex = Math.max(
      0,
      combat.initiative.findIndex((entry) => entry.id === combat.currentTurnId)
    );
    let wrapped = false;
    for (let offset = 1; offset <= combat.initiative.length; offset += 1) {
      const nextIndex = (currentIndex + offset) % combat.initiative.length;
      if (nextIndex <= currentIndex) wrapped = true;
      const candidateEntry = combat.initiative[nextIndex];
      const candidateRef = getCombatantRef(combat, candidateEntry.id);
      if (!candidateRef || !isCombatantAlive(candidateRef.combatant)) continue;
      combat.currentTurnId = candidateEntry.id;
      if (wrapped) {
        combat.round = clamp(Number(combat.round ?? 1) + 1, 1, 999);
      }
      candidateRef.combatant.actionUsed = false;
      candidateRef.combatant.defending = false;
      candidateRef.combatant.dodging = false;
      candidateRef.combatant.movementRemaining = getCombatantSpeed(candidateRef.combatant);
      syncCombatState(game);
      return { ok: true, actorName: candidateRef.combatant.name };
    }
    return { ok: false, message: "No living combatants are available in initiative." };
  }

  function resolveEnemyTurnOnce(game) {
    if (!game?.combat) {
      return { ok: false, message: "Combat is not active." };
    }
    syncCombatState(game);
    const combat = game.combat;
    const actorRef = getCombatantRef(combat, combat.currentTurnId);
    if (!actorRef || actorRef.kind !== "enemy") {
      return { ok: false, message: "Current turn is not an enemy turn." };
    }
    const enemy = actorRef.combatant;
    const pc = combat.pc;
    ensureCombatTurnState(enemy);
    const events = [];

    if (!isCombatantAlive(enemy)) {
      const advanceDown = advanceCombatTurn(game);
      if (!advanceDown.ok) return { ok: false, message: advanceDown.message };
      return {
        ok: true,
        summary: `${enemy.name} is down and cannot act.`,
      };
    }
    if (!isCombatantAlive(pc)) {
      return { ok: true, summary: "Player is already down." };
    }

    const weapon = getWeaponFromCombatant(enemy, null);
    if (!weapon) {
      enemy.actionUsed = true;
      enemy.defending = true;
      events.push(`${enemy.name} takes a defensive stance.`);
    } else {
      const attackRange = getWeaponRange(weapon);
      const moved = moveCombatantToward(enemy, pc, attackRange);
      if (moved > 0) {
        events.push(`${enemy.name} moves ${moved} to close distance.`);
      }

      const distance = distanceBetweenCombatants(enemy, pc);
      if (distance <= attackRange) {
        const damageResolution = resolveCombatAmount({
          explicitAmount: undefined,
          formula: weapon.damageFormula,
          fallback: 0,
        });
        enemy.actionUsed = true;
        const dealt = applyDamage(pc, damageResolution.amount);
        let attackMessage =
          dealt > 0
            ? `${enemy.name} attacks ${pc.name} with ${weapon.name} for ${dealt} damage.`
            : `${enemy.name} attacks ${pc.name} with ${weapon.name}.`;
        if (damageResolution.source === "rolled" && damageResolution.roll) {
          attackMessage += ` [${damageResolution.roll.formula}=${damageResolution.roll.total}]`;
        }
        events.push(attackMessage);
      } else {
        enemy.actionUsed = true;
        enemy.dodging = true;
        events.push(`${enemy.name} cannot reach attack range and takes evasive movement.`);
      }
    }

    events.forEach((entry) => addLog(game, entry, "combat"));
    syncCombatState(game);
    const outcome = resolveCombatOutcome(game);
    if (outcome) {
      return { ok: true, summary: events.join(" ") };
    }

    const advance = advanceCombatTurn(game);
    if (!advance.ok) {
      return { ok: false, message: advance.message };
    }
    return {
      ok: true,
      summary: events.join(" "),
    };
  }

  function resolveEnemyTurnsUntilPlayerTurn(game, maxTurns = 20) {
    const summaries = [];
    for (let turns = 0; turns < maxTurns; turns += 1) {
      if (!game?.combat) break;
      syncCombatState(game);
      const currentRef = getCombatantRef(game.combat, game.combat.currentTurnId);
      if (!currentRef || currentRef.kind !== "enemy") break;

      const resolved = resolveEnemyTurnOnce(game);
      if (!resolved.ok) {
        return { ok: false, message: resolved.message, summaries };
      }
      if (resolved.summary) summaries.push(resolved.summary);
      if (!game.combat) break;
    }
    return { ok: true, summaries };
  }

  function resolveTurnTransition(game) {
    const advance = advanceCombatTurn(game);
    if (!advance.ok) {
      return { ok: false, message: advance.message };
    }
    let summary = `Turn ends. It is now ${advance.actorName}'s turn.`;
    addLog(game, summary, "combat");

    const nextActorRef = game.combat
      ? getCombatantRef(game.combat, game.combat.currentTurnId)
      : null;
    if (nextActorRef?.kind === "enemy") {
      const enemyResolution = resolveEnemyTurnsUntilPlayerTurn(game);
      if (!enemyResolution.ok) {
        return { ok: false, message: enemyResolution.message };
      }
      if (enemyResolution.summaries.length > 0) {
        summary += ` Enemy turns resolved: ${enemyResolution.summaries.join(" ")}`;
      }
      if (game.combat) {
        const actorAfterEnemyTurns = getCombatantRef(
          game.combat,
          game.combat.currentTurnId
        )?.combatant;
        if (actorAfterEnemyTurns) {
          summary += ` It is now ${actorAfterEnemyTurns.name}'s turn.`;
        }
      }
    }
    return { ok: true, summary };
  }

  function applyCombatUpdate(game, combatUpdate) {
    if (!combatUpdate) return;
    if (combatUpdate.pcHp !== undefined) {
      game.hp.current = clamp(Number(combatUpdate.pcHp), 0, game.hp.max);
    }
    if (combatUpdate.pcHpDelta !== undefined) {
      game.hp.current = clamp(
        game.hp.current + Number(combatUpdate.pcHpDelta),
        0,
        game.hp.max
      );
    }
    if (combatUpdate.pcMp !== undefined) {
      game.mp.current = clamp(Number(combatUpdate.pcMp), 0, game.mp.max);
    }
    if (combatUpdate.pcMpDelta !== undefined) {
      game.mp.current = clamp(
        game.mp.current + Number(combatUpdate.pcMpDelta),
        0,
        game.mp.max
      );
    }
    if (combatUpdate.active === false) {
      game.combat = null;
      game.phase = "exploration";
      addLog(game, "Combat ended.", "combat");
      return;
    }

    if (combatUpdate.active === true) {
      const wasInCombat = game.phase === "combat" && game.combat;
      const existingCombat = game.combat ?? {};

      const hasExplicitEnemies = Array.isArray(combatUpdate.enemies);
      const hasSingleEnemyFields =
        combatUpdate.enemyName !== undefined ||
        combatUpdate.enemyHp !== undefined ||
        combatUpdate.enemyHpMax !== undefined ||
        combatUpdate.enemyIntent !== undefined;

      const existingEnemies = Array.isArray(existingCombat.enemies)
        ? existingCombat.enemies
        : [];
      let enemies = existingEnemies;

      if (hasExplicitEnemies) {
        enemies = combatUpdate.enemies
          .map((enemy, index) => {
            const existingEnemy = existingEnemies.find((entry) =>
              enemy?.id ? entry.id === enemy.id : entry.name === enemy?.name
            );
            return buildEnemyCombatant(enemy, existingEnemy, index);
          })
          .filter(Boolean);
      } else if (hasSingleEnemyFields) {
        enemies = [
          buildEnemyCombatant(
            {
              id: `enemy_${crypto.randomUUID()}`,
              name: combatUpdate.enemyName ?? "Unknown threat",
              hp: combatUpdate.enemyHp,
              hpMax: combatUpdate.enemyHpMax,
              intent: combatUpdate.enemyIntent,
            },
            null,
            0
          ),
        ].filter(Boolean);
      } else if (enemies.length === 0) {
        enemies = [
          buildEnemyCombatant(
            {
              id: `enemy_${crypto.randomUUID()}`,
              name: "Unknown threat",
              hp: 10,
              hpMax: 10,
            },
            null,
            0
          ),
        ].filter(Boolean);
      }

      const pcPatch = combatUpdate.pc ?? {};
      const pc = buildPcCombatant(game, existingCombat.pc ?? {}, pcPatch);

      const hasExplicitInitiative = Array.isArray(combatUpdate.initiative);
      let initiative = Array.isArray(existingCombat.initiative)
        ? [...existingCombat.initiative]
        : [];
      if (hasExplicitInitiative) {
        initiative = combatUpdate.initiative
          .map((entry) => {
            if (!entry?.name && !entry?.id) return null;
            const resolvedId =
              entry.id ??
              (entry.kind === "pc"
                ? pc.id
                : enemies.find((enemy) => enemy.name === entry.name)?.id) ??
              null;
            if (!resolvedId) return null;
            const isPc = resolvedId === pc.id;
            return {
              id: resolvedId,
              name: isPc
                ? pc.name
                : enemies.find((enemy) => enemy.id === resolvedId)?.name ?? entry.name ?? "Enemy",
              kind: isPc ? "pc" : "enemy",
              initiative: normalizeInitiativeScore(entry.initiative),
            };
          })
          .filter(Boolean)
          .sort((a, b) => Number(b.initiative ?? 0) - Number(a.initiative ?? 0));
      }

      const hasPcEntry = initiative.some((entry) => entry.id === pc.id);
      if (!hasPcEntry) {
        initiative.push({
          id: pc.id,
          name: pc.name,
          kind: "pc",
        });
      }
      enemies.forEach((enemy) => {
        const hasEnemyEntry = initiative.some((entry) => entry.id === enemy.id);
        if (!hasEnemyEntry) {
          initiative.push({
            id: enemy.id,
            name: enemy.name,
            kind: "enemy",
          });
        }
      });
      initiative = applyInitiativeScores(initiative).sort(
        (a, b) => Number(b.initiative ?? 0) - Number(a.initiative ?? 0)
      );

      let currentTurnId = combatUpdate.currentTurnId;
      if (!currentTurnId) {
        const previousCurrentTurnId = existingCombat.currentTurnId ?? null;
        const previousTurnStillExists = initiative.some(
          (entry) => entry.id === previousCurrentTurnId
        );
        currentTurnId = previousTurnStillExists
          ? previousCurrentTurnId
          : initiative[0]?.id ?? null;
      }

      game.combat = {
        round: Number(combatUpdate.round ?? existingCombat.round ?? 1),
        currentTurnId,
        pc,
        enemies,
        initiative,
      };
      game.phase = "combat";
      syncCombatState(game);
      if (
        game.combat &&
        getCombatantRef(game.combat, game.combat.currentTurnId)?.kind === "enemy"
      ) {
        const enemyResolution = resolveEnemyTurnsUntilPlayerTurn(game);
        if (!enemyResolution.ok) {
          addLog(game, `Enemy turn resolution failed: ${enemyResolution.message}`, "system");
        }
        syncCombatState(game);
      }

      if (!wasInCombat) {
        const enemyNames = enemies.map((enemy) => enemy.name).join(", ");
        addLog(game, `Combat begins with ${enemyNames}.`, "combat");
      }
    }
  }

  function resolveCombatAction(game, actionArgs = {}) {
    if (!game?.combat) {
      return { ok: false, message: "Combat is not active. Start combat first." };
    }
    syncCombatState(game);
    if (
      game.combat &&
      getCombatantRef(game.combat, game.combat.currentTurnId)?.kind === "enemy"
    ) {
      const enemyResolution = resolveEnemyTurnsUntilPlayerTurn(game);
      if (!enemyResolution.ok) {
        return { ok: false, message: enemyResolution.message };
      }
      syncCombatState(game);
      if (!game.combat) {
        return {
          ok: true,
          message:
            enemyResolution.summaries.length > 0
              ? `Enemy turns resolved: ${enemyResolution.summaries.join(" ")}`
              : "Enemy turns resolved.",
        };
      }
    }

    let combat = game.combat;
    let actorId = actionArgs.actorId ?? combat.currentTurnId;
    const actionType = actionArgs.action;
    let actorRef = getCombatantRef(combat, actorId);
    if (!actorRef) {
      return { ok: false, message: "Actor not found in this combat." };
    }
    if (combat.currentTurnId !== actorId) {
      return { ok: false, message: "Only the combatant whose turn it is can act." };
    }

    const actor = actorRef.combatant;
    ensureCombatTurnState(actor);
    if (!isCombatantAlive(actor)) {
      return { ok: false, message: `${actor.name} is down and cannot act.` };
    }
    if (
      actorRef.kind === "pc" &&
      COMBAT_ACTIONS_REQUIRING_ACTION.has(actionType) &&
      actionType !== "end_turn" &&
      actor.actionUsed
    ) {
      const transition = resolveTurnTransition(game);
      if (!transition.ok) {
        return { ok: false, message: transition.message };
      }
      syncCombatState(game);
      if (!game.combat) {
        return { ok: true, message: transition.summary };
      }
      combat = game.combat;
      actorId = combat.currentTurnId;
      actorRef = getCombatantRef(combat, actorId);
      if (!actorRef || actorRef.kind !== "pc") {
        return { ok: false, message: "Player turn is not ready yet. Try again." };
      }
    }
    const refreshedActor = actorRef.combatant;
    ensureCombatTurnState(refreshedActor);
    if (!isCombatantAlive(refreshedActor)) {
      return { ok: false, message: `${refreshedActor.name} is down and cannot act.` };
    }
    if (COMBAT_ACTIONS_REQUIRING_ACTION.has(actionType) && refreshedActor.actionUsed) {
      return {
        ok: false,
        message: `${refreshedActor.name} has already used an action this turn.`,
      };
    }

    const resolveTarget = (targetId) => {
      const targetRef = getCombatantRef(combat, targetId);
      if (!targetRef) return { error: "Target not found in this combat." };
      if (!isCombatantAlive(targetRef.combatant)) {
        return { error: `${targetRef.combatant.name} is already down.` };
      }
      return { targetRef };
    };

    let message = "";
    let usedAction = false;

    if (actionType === "move") {
      if (actionArgs.moveBy === undefined && actionArgs.moveTo === undefined) {
        return { ok: false, message: "Move requires moveBy or moveTo." };
      }
      const current = Number(actor.position ?? 0);
      const nextPosition =
        actionArgs.moveTo !== undefined
          ? clamp(Number(actionArgs.moveTo), 0, 100)
          : clamp(current + Number(actionArgs.moveBy), 0, 100);
      const distance = Math.abs(nextPosition - current);
      if (distance > Number(actor.movementRemaining ?? 0)) {
        return {
          ok: false,
          message: `${actor.name} only has ${actor.movementRemaining} movement remaining this turn.`,
        };
      }
      refreshedActor.position = nextPosition;
      refreshedActor.movementRemaining = clamp(
        refreshedActor.movementRemaining - distance,
        0,
        refreshedActor.speed
      );
      message = `${refreshedActor.name} moves to position ${refreshedActor.position}.`;
      addLog(game, message, "combat");
    } else if (actionType === "attack") {
      if (!actionArgs.targetId) {
        return { ok: false, message: "Attack requires a targetId." };
      }
      const targetResult = resolveTarget(actionArgs.targetId);
      if (targetResult.error) {
        return { ok: false, message: targetResult.error };
      }
      const { targetRef } = targetResult;
      if (targetRef.combatant.id === refreshedActor.id) {
        return { ok: false, message: "Attack target cannot be the same as the attacker." };
      }
      const weapon = getWeaponFromCombatant(refreshedActor, actionArgs.weaponId);
      if (!weapon) {
        return {
          ok: false,
          message: `${refreshedActor.name} must use an equipped weapon to attack.`,
        };
      }
      const attackRange = getWeaponRange(weapon);
      const distance = distanceBetweenCombatants(refreshedActor, targetRef.combatant);
      if (distance > attackRange) {
        return {
          ok: false,
          message:
            `${targetRef.combatant.name} is out of range. ` +
            `${refreshedActor.name} needs range ${attackRange} but distance is ${distance}.`,
        };
      }
      const damageResolution = resolveCombatAmount({
        explicitAmount: actionArgs.damage,
        formula: weapon.damageFormula,
        fallback: 0,
      });
      refreshedActor.actionUsed = true;
      usedAction = true;
      const dealt = applyDamage(targetRef.combatant, damageResolution.amount);
      message =
        dealt > 0
          ? `${refreshedActor.name} attacks ${targetRef.combatant.name} with ${weapon.name} for ${dealt} damage.`
          : `${refreshedActor.name} attacks ${targetRef.combatant.name} with ${weapon.name}.`;
      if (damageResolution.source === "rolled" && damageResolution.roll) {
        message += ` [${damageResolution.roll.formula}=${damageResolution.roll.total}]`;
      }
      addLog(game, message, "combat");
    } else if (actionType === "defend") {
      refreshedActor.actionUsed = true;
      refreshedActor.defending = true;
      usedAction = true;
      message = `${refreshedActor.name} takes a defensive stance.`;
      addLog(game, message, "combat");
    } else if (actionType === "dodge") {
      refreshedActor.actionUsed = true;
      refreshedActor.dodging = true;
      usedAction = true;
      message = `${refreshedActor.name} focuses on dodging.`;
      addLog(game, message, "combat");
    } else if (actionType === "use_skill") {
      if (!actionArgs.skillId) {
        return { ok: false, message: "Using a skill requires skillId." };
      }
      const skill = getUsableSkill(refreshedActor, actionArgs.skillId);
      if (!skill) {
        return {
          ok: false,
          message: `${refreshedActor.name} does not have that unlocked skill.`,
        };
      }
      if (refreshedActor.mp < skill.mpCost) {
        return {
          ok: false,
          message: `${refreshedActor.name} does not have enough MP for ${skill.name}.`,
        };
      }

      let skillTargetRef = null;
      if (skill.target === "self") {
        skillTargetRef = actorRef;
      } else {
        if (!actionArgs.targetId) {
          return { ok: false, message: `${skill.name} requires a targetId.` };
        }
        const targetResult = resolveTarget(actionArgs.targetId);
        if (targetResult.error) {
          return { ok: false, message: targetResult.error };
        }
        skillTargetRef = targetResult.targetRef;
        const distance = distanceBetweenCombatants(refreshedActor, skillTargetRef.combatant);
        const skillRange = clamp(Number(skill.range ?? DEFAULT_MELEE_RANGE), 0, MAX_RANGE);
        if (distance > skillRange) {
          return {
            ok: false,
            message:
              `${skillTargetRef.combatant.name} is out of skill range. ` +
              `${skill.name} has range ${skillRange}, distance is ${distance}.`,
          };
        }
        if (skill.target === "enemy" && skillTargetRef.kind === actorRef.kind) {
          return { ok: false, message: `${skill.name} can only target enemies.` };
        }
        if (skill.target === "ally" && skillTargetRef.kind !== actorRef.kind) {
          return { ok: false, message: `${skill.name} can only target allies.` };
        }
      }

      refreshedActor.mp = clamp(refreshedActor.mp - skill.mpCost, 0, refreshedActor.mpMax);
      refreshedActor.actionUsed = true;
      usedAction = true;
      const dealt = applyDamage(skillTargetRef.combatant, actionArgs.damage ?? 0);
      const healed = applyHealing(skillTargetRef.combatant, actionArgs.heal ?? 0);
      message = `${refreshedActor.name} uses ${skill.name}${
        skillTargetRef.combatant.id !== refreshedActor.id
          ? ` on ${skillTargetRef.combatant.name}`
          : ""
      }.`;
      if (dealt > 0) message += ` ${dealt} damage dealt.`;
      if (healed > 0) message += ` ${healed} HP restored.`;
      addLog(game, message, "combat");
    } else if (actionType === "end_turn") {
      if (!refreshedActor.actionUsed) {
        return {
          ok: false,
          message: "A turn cannot end before using one action (attack, defend, dodge, or skill).",
        };
      }
      const transition = resolveTurnTransition(game);
      if (!transition.ok) {
        return { ok: false, message: transition.message };
      }
      message = transition.summary;
    } else {
      return { ok: false, message: "Unsupported combat action." };
    }

    if (usedAction && actorRef.kind === "pc") {
      const transition = resolveTurnTransition(game);
      if (!transition.ok) {
        return { ok: false, message: transition.message };
      }
      message = `${message} ${transition.summary}`.trim();
    }

    syncCombatState(game);
    const outcome = resolveCombatOutcome(game);
    if (outcome === "victory") {
      return { ok: true, message: `${message} Combat ends in victory.`.trim() };
    }
    if (outcome === "player_down") {
      return { ok: true, message: `${message} Combat ends with the player down.`.trim() };
    }
    return { ok: true, message };
  }

  return {
    syncCombatState,
    applyCombatUpdate,
    resolveCombatAction,
  };
}
