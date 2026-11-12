import { containsPath, overlappingPaths } from "./scope";

/**
 * Which Epics wait for which. Two Epics that change the same files must not
 * run at once: the later one is built on files the earlier is rewriting.
 *
 * Every wait this produces has the Epic being planned on one side, so no
 * chain of them can close into a cycle.
 */

export interface OrderTicket {
  fileScope: readonly string[];
  storyPoints?: number | null;
  moveOnly?: boolean;
  /** Merged tickets no longer change files; they leave the comparison. */
  merged?: boolean;
}

export interface OrderEpic {
  id: string;
  key: string;
  tickets: readonly OrderTicket[];
}

export interface EpicWait {
  /** The Epic that has to wait. */
  epicId: string;
  epicKey: string;
  /** The Epic it waits for. */
  waitsForId: string;
  waitsForKey: string;
  /** The files both change, most specific entry of each overlapping pair. */
  paths: string[];
}

/** An Epic is a restructure when file moves are at least half its points. */
export function isRestructure(tickets: readonly OrderTicket[]): boolean {
  const moves = tickets.filter((t) => t.moveOnly);
  if (moves.length === 0) return false;
  const points = (list: readonly OrderTicket[]) => list.reduce((n, t) => n + (t.storyPoints ?? 1), 0);
  return points(moves) * 2 >= points(tickets);
}

function sharedPaths(a: readonly OrderTicket[], b: readonly OrderTicket[]): string[] {
  const paths = new Set<string>();
  for (const x of a) {
    for (const y of b) {
      for (const [p, q] of overlappingPaths(x.fileScope, y.fileScope)) {
        paths.add(containsPath(p, q) ? q : p);
      }
    }
  }
  return [...paths].sort();
}

/**
 * The waits the new Epic brings. `others` are the board's other Epics that
 * are not merged or archived, with all their tickets; only the unmerged ones
 * count for files.
 */
export function orderEpics(created: OrderEpic, others: readonly OrderEpic[]): EpicWait[] {
  const restructure = isRestructure(created.tickets);
  const waits: EpicWait[] = [];
  for (const other of others) {
    const paths = sharedPaths(
      created.tickets.filter((t) => !t.merged),
      other.tickets.filter((t) => !t.merged),
    );
    if (paths.length === 0) continue;
    // A new restructure goes first, except behind an earlier restructure.
    const otherFirst = !restructure || isRestructure(other.tickets);
    const [waiter, first] = otherFirst ? [created, other] : [other, created];
    waits.push({
      epicId: waiter.id,
      epicKey: waiter.key,
      waitsForId: first.id,
      waitsForKey: first.key,
      paths,
    });
  }
  return waits;
}

/** 'Waits for EPIC-95: both change a, b.' with at most five paths. */
export function waitLine(wait: Pick<EpicWait, "waitsForKey" | "paths">): string {
  const shown = wait.paths.slice(0, 5).join(", ");
  const more = wait.paths.length - 5;
  return `Waits for ${wait.waitsForKey}: both change ${shown}${more > 0 ? ` and ${more} more` : ""}.`;
}
