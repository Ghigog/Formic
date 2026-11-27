import type { BoardCard } from "@/lib/domain/entities";
import {
  AUTO_SCOUT_LEVEL,
  FOUR_SCOUTS_LEVEL,
  NO_RESERVE_LEVEL,
  RESERVE_ONE_LEVEL,
  THREE_SCOUTS_LEVEL,
  bugSeverityOf,
  isBug,
} from "./game";

/**
 * The colony: how many Coder Agents a board runs at once, and how many of
 * those slots stay free for urgent work. Ant colonies keep a share of their
 * workers idle on purpose; they are the reserve that answers an emergency
 * and the scouts that go looking for something better.
 *
 * On by default, in "auto" mode: min(8, level + 1) agents at once, with one
 * slot kept for urgent work from a cap of 4. The person may set a number of
 * their own ("manual", up to MAX_COLONY) or turn the cap "off", when only
 * file reservations hold work back. The board's level also sets how many
 * scouts a ticket may send (docs/colony.md).
 */

/** The largest colony a board may set. */
export const MAX_COLONY = 12;

/** The largest colony the automatic cap grows to. */
export const AUTO_MAX_COLONY = 8;

/** How a board's colony is capped. */
export type ColonyMode = "auto" | "manual" | "off";

/** The automatic cap at a level: a Lv 1 board runs 2 at once, 8 from Lv 7. */
export function autoColonySize(level: number): number {
  return Math.min(AUTO_MAX_COLONY, Math.max(1, Math.floor(level)) + 1);
}

/** Slots the automatic cap keeps for urgent work: one, once the colony can spare it. */
export function autoReserve(size: number): number {
  return size >= 4 ? 1 : 0;
}

/** The next level where the automatic cap grows, or null at its largest. */
export function nextAutoLevel(level: number): number | null {
  return autoColonySize(level) >= AUTO_MAX_COLONY ? null : Math.max(1, Math.floor(level)) + 1;
}

/** The least reserve a board may keep, by level: a new colony keeps two back. */
export function reserveFloor(level: number): number {
  if (level >= NO_RESERVE_LEVEL) return 0;
  if (level >= RESERVE_ONE_LEVEL) return 1;
  return 2;
}

/** The next level that lowers the reserve floor, or null at the lowest. */
export function nextFloorLevel(level: number): number | null {
  if (level < RESERVE_ONE_LEVEL) return RESERVE_ONE_LEVEL;
  if (level < NO_RESERVE_LEVEL) return NO_RESERVE_LEVEL;
  return null;
}

/** How many scouts one ticket may send, by level. */
export function maxScouts(level: number): number {
  if (level >= FOUR_SCOUTS_LEVEL) return 4;
  if (level >= THREE_SCOUTS_LEVEL) return 3;
  return 2;
}

/** The next level that lets a ticket send more scouts, or null at the most. */
export function nextScoutLevel(level: number): number | null {
  if (level < THREE_SCOUTS_LEVEL) return THREE_SCOUTS_LEVEL;
  if (level < FOUR_SCOUTS_LEVEL) return FOUR_SCOUTS_LEVEL;
  return null;
}

export { AUTO_SCOUT_LEVEL };

export interface ColonySettings {
  colonyMode: ColonyMode;
  /** The number set in "manual" mode; in the effective settings, null means no cap. */
  colonySize: number | null;
  colonyReserve: number;
  autoScout: boolean;
}

/**
 * What the colony really is at this level. Off: no cap. Auto: the level's
 * size and reserve (the floor does not apply). Manual: the person's number,
 * its reserve never below the floor, which applies only to a number they set.
 */
export function effectiveColony(settings: ColonySettings, level: number): ColonySettings {
  const { colonyMode } = settings;
  if (colonyMode === "off" || (colonyMode === "manual" && settings.colonySize === null)) {
    return { colonyMode, colonySize: null, colonyReserve: 0, autoScout: false };
  }
  const autoScout = settings.autoScout && level >= AUTO_SCOUT_LEVEL;
  if (colonyMode === "auto") {
    const size = autoColonySize(level);
    return { colonyMode, colonySize: size, colonyReserve: autoReserve(size), autoScout };
  }
  const size = Math.min(MAX_COLONY, Math.max(1, Math.round(settings.colonySize ?? 1)));
  const floor = Math.min(reserveFloor(level), size - 1);
  return {
    colonyMode,
    colonySize: size,
    colonyReserve: Math.min(size - 1, Math.max(floor, Math.round(settings.colonyReserve))),
    autoScout,
  };
}

/**
 * Work the reserve is for: a bug, or a ticket back from review with its pull
 * request open (CI to fix, a review to answer). Everything else is routine.
 */
export function isUrgent(card: BoardCard, epics: ReadonlyMap<string, BoardCard>): boolean {
  return card.workType === "bug" || isBug(card, epics) || card.prNumber !== null;
}

/** A bug of critical or high severity (its own, or its Epic's): worked before any other ticket. */
export function isTopPriority(card: BoardCard, epics: ReadonlyMap<string, BoardCard>): boolean {
  const severity = bugSeverityOf(card, epics);
  return severity === "critical" || severity === "high";
}

/** Slots a ticket takes while it runs: one, or one per scout it has out. */
export function slotsOf(card: Pick<BoardCard, "scouts" | "scoutPick">): number {
  return card.scoutPick ? 1 : Math.max(1, card.scouts ?? 0);
}

/** Slots in use on a board: every running ticket, a scouting one by its scouts. */
export function slotsInUse(cards: readonly BoardCard[]): number {
  return cards
    .filter((c) => c.kind === "ticket" && c.status === "running")
    .reduce((n, c) => n + slotsOf(c), 0);
}

export type ColonyAnswer = { ok: true } | { ok: false; reason: string };

/**
 * Whether `card` may start now with `inUse` slots taken. Routine work stops
 * at the reserve; urgent work may use it.
 */
export function colonyAdmits(
  card: BoardCard,
  inUse: number,
  settings: ColonySettings,
  epics: ReadonlyMap<string, BoardCard>,
): ColonyAnswer {
  if (settings.colonySize === null) return { ok: true };
  const need = slotsOf(card);
  const urgent = isUrgent(card, epics);
  const room = urgent ? settings.colonySize : settings.colonySize - settings.colonyReserve;
  if (inUse + need <= room) return { ok: true };
  // A ticket bigger than the whole room would otherwise never start: it may
  // when nothing else is running.
  if (inUse === 0) return { ok: true };
  return {
    ok: false,
    reason: urgent
      ? `The colony is full: ${inUse} of ${settings.colonySize} slots in use.`
      : `The colony is full: ${inUse} of ${settings.colonySize} slots in use, ${settings.colonyReserve} kept in reserve for urgent work.`,
  };
}
