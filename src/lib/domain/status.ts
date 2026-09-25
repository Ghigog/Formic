/**
 * Ticket status is the source of truth. The Kanban column is a *view* of it.
 *
 * This matters because cards are moved by two different actors: a human
 * dragging a card, and an agent finishing a run. If the column were canonical,
 * those two paths would write different fields and race. Both write `status`;
 * the board derives the column.
 */

export const COLUMNS = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
] as const;

export type ColumnId = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<ColumnId, string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

export const TICKET_STATUSES = [
  /** Backlog. Raw user input, no PRD yet. */
  "draft",
  /** Backlog. Product Agent has written a PRD. Epics only. */
  "specified",
  /** To Do. All dependencies satisfied, eligible to run. */
  "ready",
  /** To Do. Held by an unsatisfied dependency. */
  "waiting",
  /**
   * In Progress. Waiting its turn: another ticket is already writing some of
   * the same files. It starts on its own once that one stops running.
   */
  "queued",
  /** In Progress. A sandbox run is live. */
  "running",
  /** In Review. A PR is open, CI and merge are in flight. */
  "review",
  /** Done. Merged. */
  "merged",
  /** Parked anywhere. Needs a human before it can move. */
  "blocked",
  /** Terminal failure. Needs a human to retry or abandon. */
  "failed",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

const STATUS_TO_COLUMN: Record<TicketStatus, ColumnId> = {
  draft: "backlog",
  specified: "backlog",
  ready: "todo",
  waiting: "todo",
  queued: "in_progress",
  running: "in_progress",
  review: "in_review",
  merged: "done",
  // Blocked and failed cards stay in the column they stalled in; the board
  // reads `stalledIn` for those. See columnFor().
  blocked: "todo",
  failed: "todo",
};

/**
 * Where a card renders. Blocked and failed cards keep their position rather
 * than teleporting to a "blocked" column that does not exist in the design.
 */
export function columnFor(
  status: TicketStatus,
  stalledIn?: ColumnId | null,
): ColumnId {
  if ((status === "blocked" || status === "failed") && stalledIn) {
    return stalledIn;
  }
  return STATUS_TO_COLUMN[status];
}

/** A ticket no agent has touched yet: no branch, no pull request. */
export function unstarted(t: {
  status: TicketStatus;
  branchName: string | null;
  prNumber: number | null;
}): boolean {
  return (
    !t.branchName &&
    !t.prNumber &&
    (t.status === "draft" || t.status === "ready" || t.status === "waiting")
  );
}

/**
 * What a person needs to know or do about a card: why it cannot work where
 * they put it, why its agent stopped, or the work on it that is theirs, not
 * an agent's. Null when there is nothing.
 */
export function cardProblem(card: {
  status: TicketStatus;
  blockedReason?: string | null;
  misplacedReason?: string | null;
  needsHuman?: string | null;
}): string | null {
  if (card.misplacedReason) return card.misplacedReason;
  if (isStalled(card.status) && card.blockedReason) return card.blockedReason;
  if (card.needsHuman && card.status !== "merged") {
    return `${card.needsHuman.replace(/\.?\s*$/, ".")} No agent does this one. When you have, tell its chat what you did or found, and it closes.`;
  }
  return null;
}

/**
 * Where a card shows: where a person put it, when that was somewhere it
 * cannot really be, and otherwise where its status says.
 */
export function columnOf(card: {
  status: TicketStatus;
  stalledIn?: ColumnId | null;
  misplacedIn?: ColumnId | null;
}): ColumnId {
  return card.misplacedIn ?? columnFor(card.status, card.stalledIn);
}


/** Terminal states an agent will not move on from without a human. */
export function isStalled(status: TicketStatus): status is "blocked" | "failed" {
  return status === "blocked" || status === "failed";
}

export function isTerminal(status: TicketStatus): boolean {
  return status === "merged" || isStalled(status);
}

/**
 * Column moves a human may perform. Backwards moves are permitted for
 * recovery (pulling a failed card back to To Do, or a reviewed card back to
 * In Progress so its Coder Agent continues on the open pull request),
 * forwards moves only one column at a time so a card cannot skip its agent.
 */
const ALLOWED_USER_MOVES: Record<ColumnId, readonly ColumnId[]> = {
  backlog: ["todo"],
  todo: ["backlog", "in_progress"],
  in_progress: ["todo"],
  in_review: ["todo", "in_progress"],
  done: [],
};

export type MoveRejection =
  | { ok: true }
  | { ok: false; reason: string };

export function canUserMove(from: ColumnId, to: ColumnId): MoveRejection {
  if (from === to) return { ok: true };
  const allowed = ALLOWED_USER_MOVES[from];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: `Cards cannot move from ${COLUMN_LABELS[from]} to ${COLUMN_LABELS[to]}.`,
    };
  }
  return { ok: true };
}

/** Where a human may drag a card from `from`, for messages that explain a rejection. */
export function allowedUserMoves(from: ColumnId): readonly ColumnId[] {
  return ALLOWED_USER_MOVES[from];
}

/** The status a card lands in when a human drops it into a column. */
export function statusForUserDrop(
  to: ColumnId,
  dependenciesMet: boolean,
): TicketStatus {
  switch (to) {
    case "backlog":
      return "draft";
    case "todo":
      return dependenciesMet ? "ready" : "waiting";
    case "in_progress":
      return "running";
    case "in_review":
      return "review";
    case "done":
      return "merged";
  }
}
