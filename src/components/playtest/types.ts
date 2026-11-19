import type { AssistantMessageView } from "@/lib/hooks/use-assistant";

/** What the Playtest API sends. Mirrors PlaytestView in src/lib/playtest/service.ts. */
export interface PlaytestSession {
  id: string;
  status: "starting" | "live" | "failed" | "ended";
  stage: string | null;
  kind: string | null;
  url: string | null;
  commitSha: string | null;
  error: string | null;
  logTail: string[];
  startedAt: string;
  endsAt: string;
  endedAt: string | null;
  endReason: string | null;
  summary: string | null;
  newer: boolean;
}

/** A screenshot: on a note it is the attachment; in the draft it also carries the request id it was uploaded under. */
export interface PlaytestShot {
  id: string;
  url: string;
  requestId?: string;
}

export interface PlaytestMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "done" | "pending" | "failed";
  proposals: AssistantMessageView["proposals"];
  shots: PlaytestShot[];
  createdAt: string;
}

export type PlaytestAccess =
  | { ok: true }
  | { ok: false; reason: "locked" | "no-key" | "no-repo" | "no-repo-access" | "nothing-merged"; message: string };

export interface PastSession extends PlaytestSession {
  by?: string;
  mine: boolean;
  notes: number;
}

export function isOpen(s: PlaytestSession | null | undefined): boolean {
  return s?.status === "starting" || s?.status === "live";
}
