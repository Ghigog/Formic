import "server-only";

import { cookies } from "next/headers";
import { repository } from "@/lib/db";
import type { OwnerScope, UserRecord } from "@/lib/db/repository";
import { SESSION_COOKIE, authMode, verifySession } from "./session";
import { isAllowed } from "./github";

/** The one person in local mode. GitHub ids start at 1, so 0 is free. */
const LOCAL_PROFILE = { githubId: 0, login: "local", name: "Local", avatarUrl: null };

/** Found once per process, so an ordinary request reads rather than writes. */
let localUserId: string | null = null;

/** Who is making this request, or null when nobody is signed in. */
export async function currentUser(): Promise<UserRecord | null> {
  const repo = repository();
  if (authMode() === "local") {
    const known = localUserId ? await repo.userById(localUserId) : null;
    if (known) return known;
    const user = await repo.upsertUser(LOCAL_PROFILE);
    localUserId = user.id;
    return user;
  }
  const userId = await verifySession((await cookies()).get(SESSION_COOKIE)?.value);
  const user = userId ? await repo.userById(userId) : null;
  // Taking someone off FORMIC_ALLOWED_USERS takes effect now, not when their
  // session cookie runs out.
  return user && isAllowed(user.login) ? user : null;
}

/**
 * What a person can see. In local mode that includes the unowned demo board
 * and anything saved before accounts existed; signed in with GitHub, only
 * their own.
 */
export function ownerScope(user: UserRecord): OwnerScope {
  return { ownerId: user.id, includeUnowned: authMode() === "local" };
}

export function canSee(user: UserRecord, ownerId: string | null): boolean {
  return ownerId === user.id || (ownerId === null && authMode() === "local");
}
