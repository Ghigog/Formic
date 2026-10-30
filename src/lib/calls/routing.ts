import type { CallMessage, Meeting } from "@/lib/db/repository";
import { COLUMN_AGENT_GUESTS, guestLabel, type GuestId } from "./guests";
import { SENTINELS } from "@/lib/sentinels/roster";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const handle = (id: GuestId) => guestLabel(id).toLowerCase().replace(/\s+/g, "");
/** A word as it is compared: lower case, letters and digits only ("O'Chumley" is "ochumley"). */
const plain = (word: string) => word.toLowerCase().replace(/[^a-z0-9]/g, "");

/** What people call each column agent on a call, beside its label. */
const NICKNAMES: Partial<Record<GuestId, string[]>> = {
  coder: ["worker", "developer", "dev", "engineer", "builder"],
  product: ["product agent", "product owner"],
  reviewer: ["review agent"],
  architect: ["architect agent"],
};

/** Every name a guest answers to: its label, its nicknames, and a Sentinel's own name ("Professor O'Chumley"). */
function namesOf(g: GuestId): string[] {
  const names = [guestLabel(g), ...(NICKNAMES[g] ?? [])];
  if (g.startsWith("sentinel:")) {
    const who = SENTINELS.find((s) => `sentinel:${s.id}` === g)?.who;
    if (who) names.push(who, ...who.split(/\s+/).filter((w) => plain(w).length >= 5));
  }
  return names;
}

/** Edit distance, for a name said a little off ("chumly" for "Chumley"). */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const was = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = was;
    }
  }
  return row[b.length]!;
}

/** Whether `text` names `name`: exactly as words, or, for a long single name, within a letter or two. */
function names(text: string, name: string): boolean {
  if (new RegExp(`(^|[^\\w@])(?:the\\s+)?${escape(name)}(?=$|[^\\w])`, "i").test(text)) return true;
  const target = plain(name);
  if (name.includes(" ") || target.length < 5) return false;
  return text.split(/\s+/).some((w) => {
    const word = plain(w);
    return word.length >= 4 && distance(word, target) <= (target.length >= 7 ? 2 : 1);
  });
}

/** Words that open a turn without being what it is about. */
const OPENER = "(?:hello|hey|hi|hiya|morning|good\\s+(?:morning|afternoon|evening)|ok|okay|right|so|thanks|thank\\s+you|yes|well)";

/**
 * Who a message is for, the way people address each other on a call: an
 * @mention; a name to open with ("Architect, ...", "Hello architect"); a name
 * to close with ("..., Coder?"); or, naming nobody, whoever spoke last, since
 * a reply goes on with them. With nobody yet, the assistant (the PM).
 */
export function resolveAddressee(text: string, guests: readonly GuestId[], lastSpeaker?: GuestId | null): GuestId {
  const candidates = guests.filter((g) => g !== "assistant");
  for (const g of candidates) {
    if (new RegExp(`(^|\\s)@${escape(handle(g))}\\b`, "i").test(text)) return g;
  }
  const opening = text.replace(new RegExp(`^\\s*(?:${OPENER}[\\s,!.]+)*`, "i"), "");
  for (const g of candidates) {
    for (const name of namesOf(g)) {
      const word = escape(name);
      if (new RegExp(`^(?:the\\s+)?(?:old\\s+)?(?:professor\\s+)?${word}(?=$|[\\s,:;!.?\\u2014-])`, "i").test(opening)) return g;
      if (new RegExp(`(?:[,\\u2014-]|\\s)\\s*(?:the\\s+)?${word}[\\s.!?]*$`, "i").test(text)) return g;
    }
  }
  if (lastSpeaker && guests.includes(lastSpeaker)) return lastSpeaker;
  return "assistant";
}

const ADD_VERB = /\b(?:get|bring|add|invite|pull|call|put)\b(.*)$/i;

/** The guest a message asks to bring into the call ("get the Coder in", "bring old professor chumly on the phone"), or null. */
export function detectAddGuest(text: string): GuestId | null {
  const rest = ADD_VERB.exec(text)?.[1];
  if (!rest) return null;
  const invitable: GuestId[] = [...COLUMN_AGENT_GUESTS, ...SENTINELS.map((s) => `sentinel:${s.id}` as const)];
  for (const g of invitable) {
    if (namesOf(g).some((name) => names(rest, name))) return g;
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
