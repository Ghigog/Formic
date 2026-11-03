import "server-only";

import { authMode } from "@/lib/auth/session";
import { localUser } from "@/lib/auth/user";

/**
 * Who hears about a board: its owner. A board with no owner (the local demo
 * board, or one saved before accounts existed) is the local person's in
 * local mode, the same rule as `canSee`; signed in with GitHub, nobody's.
 */
export async function boardRecipient(ownerId: string | null): Promise<string | null> {
  if (ownerId) return ownerId;
  return authMode() === "local" ? (await localUser()).id : null;
}
