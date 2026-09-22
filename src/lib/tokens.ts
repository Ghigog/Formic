import type { TicketStatus } from "@/lib/domain/status";

/**
 * Status to visual token. Kept out of the components so the board, the
 * drawers, the stepper and the ambient bar cannot drift apart on what "failed"
 * looks like.
 */

export type ToneName =
  | "neutral"
  | "amber"
  | "ochre"
  | "jade"
  | "rust"
  | "crimson";

export interface Tone {
  /** Foreground use: the accessible per-theme variant. */
  text: string;
  /** Fill use: the exact brand hex from the specification. */
  fill: string;
  /** Text placed on that fill. */
  onFill: string;
  border: string;
}

export const TONES: Record<ToneName, Tone> = {
  neutral: {
    text: "text-fg-muted",
    fill: "bg-sunken",
    onFill: "text-fg",
    border: "border-line",
  },
  amber: {
    text: "text-amber-text",
    fill: "bg-amber",
    onFill: "text-on-amber",
    border: "border-amber",
  },
  ochre: {
    text: "text-ochre-text",
    fill: "bg-ochre",
    onFill: "text-on-ochre",
    border: "border-ochre",
  },
  jade: {
    text: "text-jade-text",
    fill: "bg-jade",
    onFill: "text-on-jade",
    border: "border-jade",
  },
  rust: {
    text: "text-rust-text",
    fill: "bg-rust",
    onFill: "text-on-rust",
    border: "border-rust",
  },
  crimson: {
    text: "text-crimson-text",
    fill: "bg-crimson",
    onFill: "text-on-crimson",
    border: "border-crimson",
  },
};

export const STATUS_TONE: Record<TicketStatus, ToneName> = {
  draft: "neutral",
  specified: "neutral",
  ready: "neutral",
  waiting: "neutral",
  running: "ochre",
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
