/**
 * The board chat's stream. Every message has a kind:
 *
 * - `person`: the person who owns the board wrote it.
 * - `pm`: the PM's own reply.
 * - `guest`: a column agent or a Sentinel the person summoned, replying.
 * - `notice`: Formic itself, telling the person something happened on the
 *   board ("EPIC-122-T3 is done", "Opened pull request #726"). A notice is
 *   never the PM's own words: it renders as a timeline line, and the model
 *   is given it as an event, not as something it said.
 */
export const MESSAGE_KINDS = ["person", "pm", "guest", "notice"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export function isMessageKind(v: unknown): v is MessageKind {
  return typeof v === "string" && (MESSAGE_KINDS as readonly string[]).includes(v);
}

/**
 * A message's kind: the one stored, or, for a message written before kinds
 * existed, the one its role and speaker imply.
 */
export function kindOf(m: { role: "user" | "assistant"; speaker?: string | null; kind?: string | null }): MessageKind {
  if (isMessageKind(m.kind)) return m.kind;
  if (m.role === "user") return "person";
  return m.speaker && m.speaker !== "assistant" ? "guest" : "pm";
}

/** A notice as the model reads it: an event on the board, in Formic's voice. */
export function noticeEvent(content: string): string {
  return `[Board: ${content.trim()}]`;
}

/** Replies queued for a person's message are written in the same request, well inside this. */
const REPLY_WINDOW_MS = 30_000;

type Threaded = {
  role: "user" | "assistant";
  speaker?: string | null;
  kind?: string | null;
  createdAt?: Date | string | null;
};

function timeOf(m: Threaded): number | null {
  if (!m.createdAt) return null;
  const t = new Date(m.createdAt).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * The order the chat shows, and the model reads: the order messages were
 * written, except that a reply always sits directly under the message it
 * answers. A notice written between a person's message and a reply queued for
 * it (one of several speakers still to answer, say) moves above that message,
 * so it never splits a question from its answers. A notice after the last
 * reply stays where it is, and so does a reply Formic started later on its
 * own (the PM woken for a stuck card): it answers the board, not the person.
 */
export function threadOrder<T extends Threaded>(messages: readonly T[]): T[] {
  const out: T[] = [];
  /** Where the open group's person message sits in `out`; -1 when none is open. */
  let groupAt = -1;
  let askedAt: number | null = null;
  /** Notices seen since the group's last reply: hoisted if another reply to it follows. */
  let held: T[] = [];
  const close = () => {
    out.push(...held);
    held = [];
    groupAt = -1;
  };
  for (const m of messages) {
    const kind = kindOf(m);
    if (kind === "person") {
      close();
      groupAt = out.length;
      askedAt = timeOf(m);
      out.push(m);
    } else if (kind === "notice") {
      if (groupAt < 0) out.push(m);
      else held.push(m);
    } else {
      const at = timeOf(m);
      const answersIt = groupAt >= 0 && (askedAt === null || at === null || at - askedAt <= REPLY_WINDOW_MS);
      if (!answersIt) close();
      else if (held.length) {
        out.splice(groupAt, 0, ...held);
        groupAt += held.length;
        held = [];
      }
      out.push(m);
    }
  }
  close();
  return out;
}
