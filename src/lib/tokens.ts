import type { TicketStatus } from "@/lib/domain/status";

/**
 * Status to visual token. Kept out of the components so the board, the
 * drawers, the stepper and the ambient bar cannot drift apart on what
 * "failed" looks like.
 *
 * The design rule: the status colour appears in the dot, never in the label.
 * A chip is a 12% tint of the status colour with anthracite text and a 5px
 * dot, which keeps every state legible without darkening the palette per
 * colour.
 */

export type ToneName =
  | "neutral"
  | "terracotta"
  | "clay"
  | "jade"
  | "rust"
  | "crimson";

export interface Tone {
  /** The 5px dot. The only place the status colour is used. */
  dot: string;
  /** The chip ground: the same colour at 12%. */
  chip: string;
}

export const TONES: Record<ToneName, Tone> = {
  neutral: { dot: "bg-idle", chip: "bg-idle/12" },
  terracotta: { dot: "bg-terracotta", chip: "bg-terracotta/12" },
  clay: { dot: "bg-clay", chip: "bg-clay/12" },
  jade: { dot: "bg-jade", chip: "bg-jade/12" },
  rust: { dot: "bg-rust", chip: "bg-rust/12" },
  crimson: { dot: "bg-crimson", chip: "bg-crimson/12" },
};

export const STATUS_TONE: Record<TicketStatus, ToneName> = {
  draft: "neutral",
  specified: "neutral",
  ready: "clay",
  waiting: "neutral",
  running: "clay",
  review: "rust",
  merged: "jade",
  blocked: "rust",
  failed: "crimson",
};

export const STATUS_LABEL: Record<TicketStatus, string> = {
  draft: "Draft",
  specified: "PRD ready",
  ready: "Ready",
  waiting: "Waiting",
  running: "Running",
  review: "In review",
  merged: "Merged",
  blocked: "Blocked",
  failed: "Failed",
};

export function toneFor(status: TicketStatus): Tone {
  return TONES[STATUS_TONE[status]];
}

/** Statuses that breathe: a live agent, and nothing else. */
export function isLive(status: TicketStatus): boolean {
  return status === "running";
}
