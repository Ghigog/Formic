import type { CallMessage, Meeting } from "@/lib/db/repository";
import { COLUMN_AGENT_GUESTS, guestLabel, type GuestId } from "./guests";
import { SENTINELS } from "@/lib/sentinels/roster";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const handle = (id: GuestId) => guestLabel(id).toLowerCase().replace(/\s+/g, "");

/**
 * Who a message is for: a guest named at the start ("Architect, ...") or
 * @mentioned anywhere. Anything else goes to the assistant.
 */
export function resolveAddressee(text: string, guests: readonly GuestId[]): GuestId {
  const candidates = guests.filter((g) => g !== "assistant");
  for (const g of candidates) {
    if (new RegExp(`(^|\\s)@${escape(handle(g))}\\b`, "i").test(text)) return g;
  }
  for (const g of candidates) {
    const label = escape(guestLabel(g));
    if (new RegExp(`^\\s*(?:(?:hey|hi|ok|okay)[\\s,]+)?${label}\\s*[,:;\\u2014-]`, "i").test(text)) return g;
  }
  return "assistant";
}

const ADD_VERB = /\b(?:get|bring|add|invite|pull|call)\b(.*)$/i;

/** The guest a message asks to bring into the call ("get the Coder in"), or null. */
export function detectAddGuest(text: string): GuestId | null {
  const rest = ADD_VERB.exec(text)?.[1];
  if (!rest) return null;
  const invitable: GuestId[] = [...COLUMN_AGENT_GUESTS, ...SENTINELS.map((s) => `sentinel:${s.id}` as const)];
  for (const g of invitable) {
    if (new RegExp(`(^|[^\\w])@?${escape(guestLabel(g))}\\b`, "i").test(rest)) return g;
  }
  return null;
}

/** The shared prompt block every guest sees: agenda, board snapshot and the call so far. */
export function callContext(
  meeting: Pick<Meeting, "title" | "agenda"> | null,
  boardSnapshot: string,
  messages: readonly Pick<CallMessage, "role" | "guestId" | "content">[],
): string {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "Person" : guestLabel(m.guestId ?? "assistant")}: ${m.content}`)
    .join("\n");
  return [
    `## Meeting${meeting?.title ? `: ${meeting.title}` : ""}`,
    meeting?.agenda.trim() ? `Agenda:\n${meeting.agenda.trim()}` : "No agenda.",
    `## Board\n${boardSnapshot}`,
    `## The call so far\n${transcript || "(nothing said yet)"}`,
  ].join("\n\n");
}
