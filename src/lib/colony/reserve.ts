import type { BoardCard } from "@/lib/domain/entities";
import { isBug } from "./game";

/**
 * The colony: how many Coder Agents a board runs at once, and how many of
 * those slots stay free for urgent work. Ant colonies keep a share of their
 * workers idle on purpose; they are the reserve that answers an emergency
 * and the scouts that go looking for something better.
 *
 * Off by default: with no colony size, only file reservations hold work back,
 * as before. The board's level sets how close to full it may run and how many
 * scouts a ticket may send (docs/colony.md).
 */

/** The largest colony a board may set. */
export const MAX_COLONY = 12;

/** The least reserve a board may keep, by level: a new colony keeps two back. */
export function reserveFloor(level: number): number {
  if (level >= 6) return 0;
  if (level >= 3) return 1;
  return 2;
}

/** The next level that lowers the reserve floor, or null at the lowest. */
export function nextFloorLevel(level: number): number | null {
  if (level < 3) return 3;
  if (level < 6) return 6;
  return null;
}

/** How many scouts one ticket may send, by level. */
export function maxScouts(level: number): number {
  if (level >= 7) return 4;
  if (level >= 4) return 3;
  return 2;
}

/** The level that lets idle reserve slots send scouts out on their own. */
export const AUTO_SCOUT_LEVEL = 8;

export interface ColonySettings {
  /** Null: no cap. */
  colonySize: number | null;
  colonyReserve: number;
  autoScout: boolean;
}

/** Settings held to what the level allows: the reserve never below its floor. */
export function effectiveColony(settings: ColonySettings, level: number): ColonySettings {
  if (settings.colonySize === null) return { colonySize: null, colonyReserve: 0, autoScout: false };
  const size = Math.min(MAX_COLONY, Math.max(1, Math.round(settings.colonySize)));
  const floor = Math.min(reserveFloor(level), size - 1);
  return {
    colonySize: size,
    colonyReserve: Math.min(size - 1, Math.max(floor, Math.round(settings.colonyReserve))),
    autoScout: settings.autoScout && level >= AUTO_SCOUT_LEVEL,
  };
}

/**
 * Work the reserve is for: a bug, or a ticket back from review with its pull
 * request open (CI to fix, a review to answer). Everything else is routine.
 */
export function isUrgent(card: BoardCard, epics: ReadonlyMap<string, BoardCard>): boolean {
  return card.workType === "bug" || isBug(card, epics) || card.prNumber !== null;
}

/** Slots a ticket takes while it runs: one, or one per scout it sent. */
export function slotsOf(card: Pick<BoardCard, "scouts">): number {
  return Math.max(1, card.scouts ?? 0);
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
