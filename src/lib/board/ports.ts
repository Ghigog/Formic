/**
 * What the board service needs from the pipelines that run work on a card.
 *
 * The service used to import the coder and review pipelines directly, and
 * those reach back to it through the runner and card actions: a runtime import
 * cycle. The service now calls these ports; src/lib/board/wiring.ts registers
 * the real pipelines once at startup, and tests register fakes.
 */

import type { CardTransition, TransitionResult } from "@/lib/domain/transitions";
import type { BoardCard } from "@/lib/domain/entities";
import type { TicketDetail } from "@/lib/db/repository";

export type EpicActionResult = { ok: true } | { ok: false; reason: string; status: number };

export interface CoderPort {
  runCoderAgent(projectId: string, ticketId: string, options?: { instruction?: string }): Promise<void>;
}

export interface ReviewPort {
  reviewPullRequest(
    projectId: string,
    prNumber: number,
    headSha: string,
    options?: { startReview?: boolean },
  ): Promise<void>;
  completeEpic(projectId: string, epicId: string, position?: number): Promise<void>;
  startShowcase(projectId: string, epicId: string): Promise<void>;
  mergeByPerson(
    projectId: string,
    ticket: TicketDetail,
    prNumber: number,
  ): Promise<string>;
}

/**
 * The board service itself, for callers the pipelines reach (card actions):
 * importing it directly would close a cycle through the runner.
 */
export interface BoardServicePort {
  applyTransition(projectId: string, t: CardTransition): Promise<TransitionResult>;
  redraftTicket(projectId: string, ticketId: string): Promise<boolean>;
  retryEpic(projectId: string, epicId: string): Promise<EpicActionResult>;
  advanceQueens(projectId: string): Promise<void>;
  deleteEpic(projectId: string, epicId: string): Promise<EpicActionResult>;
  createBacklogItem(projectId: string, rawRequest: string, requestId?: string): Promise<BoardCard>;
}

export interface BoardPorts {
  coder: CoderPort;
  review: ReviewPort;
  service: BoardServicePort;
}

/**
 * Held on globalThis: Next.js bundles the instrumentation hook and each route
 * separately, so a module-level variable would be a different copy in each and
 * the registration made at startup would be invisible to the routes.
 */
const KEY = Symbol.for("formic.boardPorts");
type Holder = { [KEY]?: BoardPorts };

export function registerBoardPorts(ports: BoardPorts): void {
  (globalThis as Holder)[KEY] = ports;
}

export function boardPorts(): BoardPorts {
  const registered = (globalThis as Holder)[KEY];
  if (!registered) {
    throw new Error(
      "Board ports are not registered. Import '@/lib/board/wiring' (the server entry does) or call registerBoardPorts() first.",
    );
  }
  return registered;
}

/** For tests: forget the registered ports. */
export function clearBoardPorts(): void {
  delete (globalThis as Holder)[KEY];
}
