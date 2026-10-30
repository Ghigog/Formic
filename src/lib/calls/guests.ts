import { AGENT_ROLE_LABELS, COLUMN_AGENT_ROLE, type AgentRole } from "@/lib/domain/entities";
import { isUnlocked, SENTINELS } from "@/lib/sentinels/roster";

/** Who can join a call: the assistant, a column's agent, or a Sentinel. */
export type GuestId = "assistant" | AgentRole | `sentinel:${string}`;

const SENTINEL_PREFIX = "sentinel:";

/** The column agents a call can invite, in column order. */
export const COLUMN_AGENT_GUESTS: readonly AgentRole[] = [...new Set(Object.values(COLUMN_AGENT_ROLE))];

/** The name a guest goes by. */
export function guestLabel(id: GuestId): string {
  if (id === "assistant") return "PM";
  if (id.startsWith(SENTINEL_PREFIX)) {
    return SENTINELS.find((s) => `${SENTINEL_PREFIX}${s.id}` === id)?.name ?? id;
  }
  return AGENT_ROLE_LABELS[id as AgentRole] ?? id;
}

export function isGuestId(value: unknown): value is GuestId {
  if (typeof value !== "string") return false;
  if (value === "assistant") return true;
  if (value.startsWith(SENTINEL_PREFIX)) {
    return SENTINELS.some((s) => `${SENTINEL_PREFIX}${s.id}` === value);
  }
  return (COLUMN_AGENT_GUESTS as readonly string[]).includes(value);
}

/** The guests a call can invite at a colony level: Sentinels not yet unlocked are left out. */
export function guestOptions(level: number): { id: GuestId; label: string }[] {
  const ids: GuestId[] = [
    "assistant",
    ...COLUMN_AGENT_GUESTS,
    ...SENTINELS.filter((s) => isUnlocked(s, level)).map((s): GuestId => `${SENTINEL_PREFIX}${s.id}`),
  ];
  return ids.map((id) => ({ id, label: guestLabel(id) }));
}
