import "server-only";

import { normalizeRepo } from "@/lib/secrets/repo";

import type {
  CreateEpicInput,
  CreateTicketInput,
  MoveInput,
  ProjectSummary,
  Repository,
  RunOutcome,
  RunRecord,
  TicketDetail,
  TicketUpdate,
} from "./repository";
import type { AgentRunStatus, BoardCard } from "@/lib/domain/entities";
import { type ColumnId, columnFor } from "@/lib/domain/status";
import { byPosition, needsRebalance, rebalance } from "@/lib/ordering";
import { normalizeScope } from "@/lib/domain/scope";

/**
 * Runs the whole board with no database. Used when DATABASE_URL is unset so a
 * fresh clone starts with `npm run dev` and nothing else.
 *
 * State lives for the lifetime of the server process: a browser reload keeps
 * the board, a server restart does not. That is the honest limit of this
 * implementation and the reason it is not the production path.
 */

let seq = 0;
let idCounter = 0;
const id = (prefix: string) => `${prefix}_${(++idCounter).toString(36)}`;

/** The ticket fields the board does not render and so BoardCard does not carry. */
interface TicketExtras {
  description: string;
  acceptanceCriteria: string[];
  branchName: string | null;
  attempts: number;
  summary: string | null;
}

interface Store {
  project: ProjectSummary;
  cards: Map<string, BoardCard>;
  ticketExtras: Map<string, TicketExtras>;
  prds: Map<string, unknown>;
  rawRequests: Map<string, string>;
  showcases: Map<string, string>;
  events: Array<{ seq: number; type: string; payload: unknown; at: Date }>;
  runs: Map<string, RunRecord & { status: AgentRunStatus; startedAt: Date }>;
  deliveries: Set<string>;
}

declare global {
  // eslint-disable-next-line no-var
  var __formicMemoryStore: Store | undefined;
}

function store(): Store {
  if (globalThis.__formicMemoryStore) return globalThis.__formicMemoryStore;
  const s: Store = {
    project: {
      id: "project_default",
      name: "Formic",
      repoFullName: normalizeRepo(process.env.GITHUB_REPO) ?? "Ghigog/Formic",
      baseBranch: process.env.GITHUB_BASE_BRANCH ?? "main",
    },
    cards: new Map(),
    ticketExtras: new Map(),
    prds: new Map(),
    rawRequests: new Map(),
    showcases: new Map(),
    events: [],
    runs: new Map(),
    deliveries: new Set(),
  };
  globalThis.__formicMemoryStore = s;
  return s;
}

export function seedMemory(cards: BoardCard[]): void {
  const s = store();
  if (s.cards.size > 0) return;
  for (const card of cards) s.cards.set(card.id, { ...card });
}

export class MemoryRepository implements Repository {
  async defaultProject(): Promise<ProjectSummary> {
    return store().project;
  }

  async boardCards(): Promise<BoardCard[]> {
    const cards = [...store().cards.values()];
    for (const card of cards) {
      if (card.kind !== "epic") continue;
      const children = cards.filter((c) => c.epicId === card.id);
      card.childCount = children.length;
      card.doneCount = children.filter((c) => c.status === "merged").length;
    }
    return cards.sort(byPosition);
  }

  async createEpic(input: CreateEpicInput): Promise<BoardCard> {
    const s = store();
    const n = [...s.cards.values()].filter((c) => c.kind === "epic").length + 1;
    const card: BoardCard = {
      id: id("epic"),
      kind: "epic",
      key: `EPIC-${n}`,
      title: input.title,
      status: "draft",
      stalledIn: null,
      stage: 1,
      position: input.position,
      epicId: null,
      size: null,
      agentRole: null,
      model: null,
      fileScope: [],
      dependsOn: [],
      prNumber: null,
      prUrl: null,
      blockedReason: null,
      costCents: 0,
      childCount: 0,
      doneCount: 0,
    };
    s.cards.set(card.id, card);
    s.rawRequests.set(card.id, input.rawRequest);
    return card;
  }

  async createTickets(inputs: CreateTicketInput[]): Promise<BoardCard[]> {
    const s = store();
    const made = new Map<string, BoardCard>();

    for (const input of inputs) {
      const card: BoardCard = {
        id: id("ticket"),
        kind: "ticket",
        key: input.key,
        title: input.title,
        status: input.dependsOnKeys.length === 0 ? "ready" : "waiting",
        stalledIn: null,
        stage: 3,
        position: input.position,
        epicId: input.epicId,
        size: input.size,
        agentRole: null,
        model: null,
        fileScope: normalizeScope(input.fileScope),
        dependsOn: [],
        prNumber: null,
        prUrl: null,
        blockedReason: null,
        costCents: 0,
        childCount: 0,
        doneCount: 0,
      };
      made.set(input.key, card);
      s.ticketExtras.set(card.id, {
        description: input.description,
        acceptanceCriteria: input.acceptanceCriteria,
        branchName: null,
        attempts: 0,
        summary: null,
      });
    }

    for (const input of inputs) {
      const card = made.get(input.key);
      if (!card) continue;
      card.dependsOn = input.dependsOnKeys
        .map((k) => made.get(k)?.id)
        .filter((v): v is string => !!v);
      s.cards.set(card.id, card);
    }

    return [...made.values()];
  }

  async move(input: MoveInput): Promise<void> {
    const card = store().cards.get(input.cardId);
    if (!card) return;
    card.status = input.status;
    card.stalledIn = input.stalledIn;
    card.position = input.position;
    if (input.detached !== undefined) card.detached = input.detached;
  }

  async columnPositions(_projectId: string, column: ColumnId): Promise<number[]> {
    return (await this.boardCards())
      .filter((c) => columnFor(c.status, c.stalledIn) === column)
      .map((c) => c.position)
      .sort((a, b) => a - b);
  }

  async cardById(cardId: string): Promise<BoardCard | null> {
    return store().cards.get(cardId) ?? null;
  }

  async epicDetail(epicId: string) {
    const s = store();
    const card = s.cards.get(epicId);
    if (!card) return null;
    return {
      title: card.title,
      rawRequest: s.rawRequests.get(epicId) ?? card.title,
      prd: s.prds.get(epicId) ?? null,
    };
  }

  async setEpicPrd(epicId: string, prd: unknown): Promise<void> {
    const s = store();
    s.prds.set(epicId, prd);
    const card = s.cards.get(epicId);
    if (card) {
      card.status = "specified";
      card.stage = 2;
    }
  }

  async setEpicShowcase(epicId: string, markdown: string): Promise<void> {
    const s = store();
    s.showcases.set(epicId, markdown);
    const card = s.cards.get(epicId);
    if (card) card.stage = 8;
  }

  async appendEvent(
    _projectId: string,
    type: string,
    payload: unknown,
  ): Promise<number> {
    const s = store();
    const next = ++seq;
    s.events.push({ seq: next, type, payload, at: new Date() });
    // Bounded: this is a demo store, not a durable log.
    if (s.events.length > 2000) s.events.splice(0, s.events.length - 2000);
    return next;
  }

  async eventsAfter(_projectId: string, after: number, limit = 500) {
    return store()
      .events.filter((e) => e.seq > after)
      .slice(0, limit);
  }

  async latestEventSeq(_projectId: string): Promise<number> {
    return store().events.at(-1)?.seq ?? 0;
  }

  async ticketDetail(ticketId: string): Promise<TicketDetail | null> {
    const s = store();
    const card = s.cards.get(ticketId);
    if (!card || card.kind !== "ticket") return null;
    return toDetail(card, s.ticketExtras.get(ticketId), s.project.id);
  }

  async ticketByPrNumber(
    _projectId: string,
    prNumber: number,
  ): Promise<TicketDetail | null> {
    const s = store();
    for (const card of s.cards.values()) {
      if (card.kind === "ticket" && card.prNumber === prNumber) {
        return toDetail(card, s.ticketExtras.get(card.id), s.project.id);
      }
    }
    return null;
  }

  async updateTicket(ticketId: string, update: TicketUpdate): Promise<void> {
    const s = store();
    const card = s.cards.get(ticketId);
    if (!card) return;

    if (update.status !== undefined) card.status = update.status;
    // A merged ticket joins its epic's group in Done, wherever it sat.
    if (update.status === "merged") card.detached = false;
    if (update.stalledIn !== undefined) card.stalledIn = update.stalledIn;
    if (update.stage !== undefined) card.stage = update.stage;
    if (update.prNumber !== undefined) card.prNumber = update.prNumber;
    if (update.prUrl !== undefined) card.prUrl = update.prUrl;
    if (update.blockedReason !== undefined) {
      card.blockedReason = update.blockedReason;
    }
    if (update.costCents !== undefined) card.costCents += update.costCents;

    const extras = s.ticketExtras.get(ticketId);
    if (!extras) return;
    if (update.branchName !== undefined) extras.branchName = update.branchName;
    if (update.attempts !== undefined) extras.attempts = update.attempts;
    if (update.summary !== undefined) extras.summary = update.summary;
  }

  async ticketsForEpic(epicId: string): Promise<TicketDetail[]> {
    const s = store();
    return [...s.cards.values()]
      .filter((c) => c.kind === "ticket" && c.epicId === epicId)
      .sort(byPosition)
      .map((c) => toDetail(c, s.ticketExtras.get(c.id), s.project.id));
  }

  async startRun(run: RunRecord): Promise<void> {
    store().runs.set(run.id, { ...run, status: "running", startedAt: new Date() });
  }

  async finishRun(runId: string, outcome: RunOutcome): Promise<void> {
    const run = store().runs.get(runId);
    if (run) run.status = outcome.status;
  }

  async unfinishedRuns(
    startedBefore: Date,
  ): Promise<Array<RunRecord & { status: AgentRunStatus }>> {
    return [...store().runs.values()].filter(
      (r) =>
        (r.status === "queued" || r.status === "running") &&
        r.startedAt < startedBefore,
    );
  }

  async claimDelivery(key: string): Promise<boolean> {
    const s = store();
    if (s.deliveries.has(key)) return false;
    s.deliveries.add(key);
    // Bounded, like the event log: this is a demo store.
    if (s.deliveries.size > 5000) {
      const oldest = s.deliveries.values().next().value;
      if (oldest) s.deliveries.delete(oldest);
    }
    return true;
  }

  async rebalanceColumn(_projectId: string, column: ColumnId): Promise<void> {
    const cards = (await this.boardCards())
      .filter((c) => columnFor(c.status, c.stalledIn) === column)
      .sort(byPosition);
    if (!needsRebalance(cards.map((c) => c.position))) return;
    const fresh = rebalance(cards.length);
    cards.forEach((card, i) => {
      card.position = fresh[i]!;
    });
  }
}

function toDetail(
  card: BoardCard,
  extras: TicketExtras | undefined,
  projectId: string,
): TicketDetail {
  return {
    id: card.id,
    epicId: card.epicId ?? "",
    projectId,
    key: card.key,
    title: card.title,
    description: extras?.description ?? card.title,
    acceptanceCriteria: extras?.acceptanceCriteria ?? [],
    fileScope: card.fileScope,
    status: card.status,
    stalledIn: card.stalledIn,
    stage: card.stage,
    branchName: extras?.branchName ?? null,
    prNumber: card.prNumber,
    prUrl: card.prUrl,
    blockedReason: card.blockedReason,
    attempts: extras?.attempts ?? 0,
    summary: extras?.summary ?? null,
  };
}
