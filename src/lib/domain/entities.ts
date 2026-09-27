import { z } from "zod";
import { COLUMNS, TICKET_STATUSES } from "./status";
import { LIFECYCLE_STAGES } from "./stages";
import { PROVIDER_IDS, provider as providerInfo, type ProviderId } from "@/lib/llm/providers";

/**
 * The shapes every layer agrees on: API routes, agents, the database mapper
 * and the board. Zod rather than bare types because the same definitions
 * validate LLM output in PROT-03/04 and request bodies in PROT-02.
 */

export const AGENT_ROLES = [
  "product",
  "architect",
  "coder",
  "reviewer",
  "pm",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  product: "Product",
  architect: "Architect",
  coder: "Coder",
  reviewer: "Reviewer",
  pm: "PM",
};

export const AGENT_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const CARD_KINDS = ["epic", "ticket"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export const TICKET_SIZES = ["S", "M", "L", "XL"] as const;
export type TicketSize = (typeof TICKET_SIZES)[number];

export const ATTACHMENT_KINDS = ["image", "file"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/**
 * What the client and drawers see of a stored file: never the raw bytes,
 * which stay behind attachmentContent so a board payload never carries them.
 */
export interface AttachmentSummary {
  id: string;
  filename: string;
  mimeType: string;
  kind: AttachmentKind;
  size: number;
  url: string;
}

/** Story points: the Fibonacci scale from 1 to 13. */
export const STORY_POINTS = [1, 2, 3, 5, 8, 13] as const;
export type StoryPoints = (typeof STORY_POINTS)[number];

/** One step of the plan an agent works a ticket through. */
export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "done";
}

export const planStepSchema = z.object({
  step: z.string().trim().min(1).max(300),
  status: z.enum(["pending", "in_progress", "done"]),
});

/** A directory prefix. Validated further by normalizeScopePath. */
export const filePathSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !s.includes(".."), "File scope may not contain '..'");

export const fileScopeSchema = z
  .array(filePathSchema)
  .min(1, "Every ticket must declare at least one file scope entry.")
  .max(12, "A ticket with more than 12 scope entries is too broad to isolate.");

export const projectSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  repoFullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/repo"),
  baseBranch: z.string().min(1).default("main"),
  createdAt: z.coerce.date(),
});
export type Project = z.infer<typeof projectSchema>;

export const prdSchema = z.object({
  summary: z.string().min(1),
  problem: z.string().min(1),
  scope: z.array(z.string().min(1)).min(1),
  outOfScope: z.array(z.string().min(1)).default([]),
  technicalContext: z.array(z.string().min(1)).default([]),
  userStories: z.array(z.string().min(1)).default([]),
  successCriteria: z.array(z.string().min(1)).min(1),
});
export type Prd = z.infer<typeof prdSchema>;

export const epicSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string().min(1),
  rawRequest: z.string().min(1),
  prd: prdSchema.nullable(),
  prdEditedByHuman: z.boolean().default(false),
  status: z.enum(TICKET_STATUSES),
  stalledIn: z.enum(COLUMNS).nullable().default(null),
  stage: z.number().int().min(1).max(8),
  position: z.number(),
  showcase: z.string().nullable().default(null),
  /** A holder for a ticket with no Epic of its own. See BoardCard.standalone. */
  standalone: z.boolean().default(false),
  rerouteFrom: z.enum(COLUMNS).nullable().default(null),
  rerouteReason: z.string().nullable().default(null),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Epic = z.infer<typeof epicSchema>;

export const ticketSchema = z.object({
  id: z.string(),
  epicId: z.string(),
  /** Stable human-facing key, e.g. "FOR-014". Rendered in mono on the card. */
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  fileScope: fileScopeSchema,
  size: z.enum(TICKET_SIZES).default("M"),
  status: z.enum(TICKET_STATUSES),
  stalledIn: z.enum(COLUMNS).nullable().default(null),
  stage: z.number().int().min(1).max(8),
  position: z.number(),
  branchName: z.string().nullable().default(null),
  prNumber: z.number().int().nullable().default(null),
  prUrl: z.string().nullable().default(null),
  blockedReason: z.string().nullable().default(null),
  rerouteFrom: z.enum(COLUMNS).nullable().default(null),
  rerouteReason: z.string().nullable().default(null),
  attempts: z.number().int().min(0).default(0),
  costCents: z.number().min(0).default(0),
  tokensIn: z.number().int().min(0).default(0),
  tokensOut: z.number().int().min(0).default(0),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const ticketDependencySchema = z.object({
  ticketId: z.string(),
  dependsOnTicketId: z.string(),
});
export type TicketDependency = z.infer<typeof ticketDependencySchema>;

export const agentRunSchema = z.object({
  id: z.string(),
  role: z.enum(AGENT_ROLES),
  epicId: z.string().nullable(),
  ticketId: z.string().nullable(),
  status: z.enum(AGENT_RUN_STATUSES),
  model: z.string().nullable(),
  tokensIn: z.number().int().min(0).default(0),
  tokensOut: z.number().int().min(0).default(0),
  costCents: z.number().min(0).default(0),
  sandboxId: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  startedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;

/** What the board renders. Epics and tickets share a card surface. */
export interface BoardCard {
  id: string;
  kind: CardKind;
  key: string;
  title: string;
  status: (typeof TICKET_STATUSES)[number];
  stalledIn: (typeof COLUMNS)[number] | null;
  stage: number;
  position: number;
  epicId: string | null;
  /** A ticket the user pulled out of its epic's group. Renders on its own. */
  detached?: boolean;
  /**
   * Epics only: a holder for a ticket with no Epic of its own. Never its own
   * card on the board — boardCards() excludes it, and its one child ticket
   * renders alone, marked detached, exactly as today.
   */
  standalone?: boolean;
  /** The column a request was rerouted from, and why. Null outside a reroute. */
  rerouteFrom?: (typeof COLUMNS)[number] | null;
  rerouteReason?: string | null;
  size: TicketSize | null;
  /** Tickets only: the estimate, 1 to 13. Null when none was given. */
  storyPoints?: number | null;
  /**
   * Tickets only: work for a person, not an agent, and why. No agent starts
   * it; the person does it and closes it from its chat.
   */
  needsHuman?: string | null;
  agentRole: AgentRole | null;
  model: string | null;
  fileScope: string[];
  dependsOn: string[];
  prNumber: number | null;
  prUrl: string | null;
  blockedReason: string | null;
  /**
   * Where a person put it when that was not somewhere it can be. It shows
   * there, with `misplacedReason` saying what is wrong and how to fix it,
   * while its status stays what is really true of it. Null when it is where
   * its status says.
   */
  misplacedIn?: (typeof COLUMNS)[number] | null;
  misplacedReason?: string | null;
  costCents: number;
  childCount: number;
  doneCount: number;
  /** ISO time the card was made. Drives the timeline. */
  createdAt?: string;
  /** ISO time its first agent run started, or null before any has. */
  startedAt?: string | null;
  /** ISO time it last changed. */
  updatedAt?: string;
  /**
   * ISO time the agent working on it now started, or null when none is.
   * Drives the timer on a card while it is being worked on, and only then.
   */
  workingSince?: string | null;
  /** Tickets: when it merged, and what the merge scored. Null before then. */
  mergedAt?: string | null;
  mergePoints?: number | null;
  mergeMultiplier?: number | null;
}

export const STAGE_COUNT = LIFECYCLE_STAGES.length;

/** The agent each column runs, and so the one a preset on it replaces. */
export const COLUMN_AGENT_ROLE: Record<(typeof COLUMNS)[number], AgentRole> = {
  backlog: "product",
  todo: "architect",
  in_progress: "coder",
  in_review: "reviewer",
  done: "pm",
};

/** A saved agent as the board sees it. The key itself never leaves the server. */
export interface AgentPreset {
  id: string;
  ownerId: string | null;
  /** The column it was made for, set once on create. Null shows everywhere. */
  column: (typeof COLUMNS)[number] | null;
  name: string;
  provider: ProviderId;
  model: string;
  prompt: string;
  /** False means runs use the server's ANTHROPIC_API_KEY. */
  hasKey: boolean;
  keyHint: string | null;
  /**
   * ISO time this agent's plan is out of usage until, or null. A column
   * running it takes no work until then.
   */
  limitedUntil: string | null;
  /** What the agent said when it ran out. */
  limitNote: string | null;
}

export const agentPresetInputSchema = z
  .object({
    name: z.string().trim().min(1, "Give the agent a name.").max(60),
    /** The column it's scoped to. Only honoured when creating a preset. */
    column: z.enum(COLUMNS).nullable().default(null),
    provider: z.enum(PROVIDER_IDS).default("anthropic"),
    /** Empty for a CLI agent means its own default model. */
    model: z.string().trim().max(200).default(""),
    /** May be empty only for the board's assistant, which needs no brief. */
    prompt: z.string().trim().max(20_000),
    /** A new key; null clears the saved one; omitted keeps it. A Codex sign-in is a JSON file, hence the length. */
    apiKey: z.string().trim().min(1).max(20_000).nullable().optional(),
  })
  .refine((p) => p.model !== "" || providerInfo(p.provider)?.kind === "cli", {
    message: "Pick a model.",
    path: ["model"],
  });
export type AgentPresetInput = z.infer<typeof agentPresetInputSchema>;

/** Which preset runs each column on one board. Unset columns run built-ins. */
export type ColumnAgents = Partial<Record<(typeof COLUMNS)[number], string>>;
