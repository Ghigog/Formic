import "server-only";

import type {
  CreateEpicInput,
  CreateTicketInput,
  MoveInput,
  ProjectSummary,
  Repository,
} from "./repository";
import type { BoardCard } from "@/lib/domain/entities";
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

interface Store {
  project: ProjectSummary;
  cards: Map<string, BoardCard>;
  prds: Map<string, unknown>;
  rawRequests: Map<string, string>;
  showcases: Map<string, string>;
  events: Array<{ seq: number; type: string; payload: unknown; at: Date }>;
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
      repoFullName: process.env.GITHUB_REPO ?? "Ghigog/Formic",
      baseBranch: process.env.GITHUB_BASE_BRANCH ?? "main",
    },
    cards: new Map(),
    prds: new Map(),
    rawRequests: new Map(),
    showcases: new Map(),
    events: [],
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
