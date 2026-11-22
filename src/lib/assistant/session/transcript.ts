/**
 * What the board's PM session is told each turn, and the running summary
 * Formic keeps of the conversation (docs/plans/pm-chat.md, PR 3).
 *
 * The session remembers what it said: a turn carries only what is new to it,
 * the person's message and the board events and guest replies since its last
 * turn. A fresh session (the first, after Clear, or after its file was lost
 * or grew past the cap) starts from its brief and the summary instead of a
 * replay of the chat.
 *
 * Pure: no server imports, tested as such.
 */

import { kindOf, noticeEvent, threadOrder, type MessageKind } from "@/lib/domain/chat";

/** What this module reads of a chat message. */
export interface ChatLine {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "done" | "pending" | "failed";
  speaker: string;
  kind?: MessageKind | null;
  createdAt: Date;
}

/** How many of the latest chat lines the summary keeps. */
export const SUMMARY_LINES = 30;
/** The most one line of the summary keeps. */
const SUMMARY_LINE_CHARS = 280;
/** The most the whole summary keeps; the newest lines win. */
export const SUMMARY_CHARS = 6_000;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Who said a line, as the summary names them. `guestName` labels a column agent or Sentinel. */
function speakerOf(m: ChatLine, guestName: (speaker: string) => string): string {
  const kind = kindOf(m);
  if (kind === "person") return "Person";
  if (kind === "notice") return "Board";
  if (kind === "guest") return guestName(m.speaker);
  return "PM";
}

/**
 * A short running summary of the conversation: its latest lines, each cut to
 * one line, newest last. Kept after every turn, it is what a fresh session
 * starts from, so a lost session file costs detail and never the thread.
 */
export function runningSummary(messages: readonly ChatLine[], guestName: (speaker: string) => string = (s) => s): string {
  const lines = threadOrder(messages)
    .filter((m) => m.status === "done" && m.content.trim())
    .slice(-SUMMARY_LINES)
    .map((m) => `- ${speakerOf(m, guestName)}: ${oneLine(m.content, SUMMARY_LINE_CHARS)}`);
  const kept: string[] = [];
  let size = 0;
  for (const line of lines.reverse()) {
    if (size + line.length + 1 > SUMMARY_CHARS) break;
    kept.unshift(line);
    size += line.length + 1;
  }
  return kept.join("\n");
}

/**
 * What is new to the session before the reply `replyId`: everything said
 * since the PM's last reply, except its own words, in the order the chat
 * shows. The session already holds what came before.
 */
export function newSince(messages: readonly ChatLine[], replyId: string): ChatLine[] {
  const ordered = threadOrder(messages);
  const at = ordered.findIndex((m) => m.id === replyId);
  const before = at < 0 ? ordered : ordered.slice(0, at);
  let from = 0;
  before.forEach((m, i) => {
    if (kindOf(m) === "pm" && m.status !== "pending") from = i + 1;
  });
  return before.slice(from).filter((m) => m.status === "done" && m.content.trim() && kindOf(m) !== "pm");
}

/** Everything before the reply `replyId`, in the order the chat shows. */
export function before(messages: readonly ChatLine[], replyId: string): ChatLine[] {
  const ordered = threadOrder(messages);
  const at = ordered.findIndex((m) => m.id === replyId);
  return at < 0 ? ordered : ordered.slice(0, at);
}

/** The person's message `replyId` answers: the last one before it. */
export function askedBy(messages: readonly ChatLine[], replyId: string): ChatLine | null {
  const ordered = threadOrder(messages);
  const at = ordered.findIndex((m) => m.id === replyId);
  const before = at < 0 ? ordered : ordered.slice(0, at);
  return [...before].reverse().find((m) => kindOf(m) === "person") ?? null;
}

/**
 * One turn's message to the session. `fresh` sessions are handed their
 * brief and the summary first. `wake` is Formic's own message, for a turn
 * nobody typed (a card that stopped).
 */
export function turnMessage(input: {
  fresh: boolean;
  brief: string;
  summary: string;
  /** Said since the last turn, the person's message last. */
  lines: readonly ChatLine[];
  guestName?: (speaker: string) => string;
  wake?: string;
  /** Signed links to the pictures the person sent, as a prompt section. */
  files?: string | null;
}): string {
  const name = input.guestName ?? ((s: string) => s);
  const said = input.lines.map((m) => {
    const kind = kindOf(m);
    if (kind === "notice") return noticeEvent(m.content);
    if (kind === "guest") return `[${name(m.speaker)} said in the chat: ${m.content.trim()}]`;
    return m.content.trim();
  });
  const body = [
    ...said,
    ...(input.wake ? [`[Formic: ${input.wake.trim()}]`] : []),
    ...(input.files ? ["", input.files] : []),
  ].join("\n\n");
  if (!input.fresh) return body || "[Formic: carry on.]";
  return [
    input.brief,
    ...(input.summary.trim()
      ? ["", "What was said in this board's chat before this session, oldest first (a summary, not a replay):", input.summary]
      : []),
    "",
    "---",
    "",
    body || "[Formic: say hello in one line and wait for the person.]",
  ].join("\n");
}
