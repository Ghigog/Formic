import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { repository } from "@/lib/db";
import type { UserRecord } from "@/lib/db/repository";
import { isAllowed } from "./github";
import { mailer } from "./mailer";
import { firstSignIn } from "./user";

/**
 * Signing in with an emailed link.
 *
 * The link carries 32 random bytes. Only their SHA-256 is stored, so a copy
 * of the database signs nobody in. A link works once, for fifteen minutes,
 * and spending it is a POST from a confirm page: mail scanners that open
 * every link in a message must not spend it before the person clicks.
 *
 * Starting sign-in answers the same whatever the address, so the login page
 * can't be used to find out who has an account.
 */

export const LINK_MINUTES = 15;
const LINK_MS = LINK_MINUTES * 60_000;

/** Three links per address per fifteen minutes, ten per IP per hour. */
const PER_EMAIL = { count: 3, windowMs: 15 * 60_000 };
const PER_IP = { count: 10, windowMs: 60 * 60_000 };

/** Lowercased and trimmed, or null when it isn't an email address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254) return null;
  // Deliberately plain: one @, something on each side, a dot in the domain.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type StartResult = "sent" | "invalid" | "limited" | "unavailable";

/**
 * Sends a sign-in link, unless this address or IP has asked too often, or the
 * address isn't on the allow-list (then nothing is sent, and the caller says
 * "sent" all the same).
 */
export async function startEmailSignIn(input: {
  email: unknown;
  next: string;
  ip: string;
  /** Builds the link: the confirm page on this deployment's public address. */
  linkFor: (token: string) => string;
  now?: Date;
}): Promise<StartResult> {
  const send = mailer();
  if (!send) return "unavailable";
  const email = normalizeEmail(input.email);
  if (!email) return "invalid";

  const now = input.now ?? new Date();
  const repo = repository();
  const [byEmail, byIp] = await Promise.all([
    repo.countLoginTokens({ email }, new Date(now.getTime() - PER_EMAIL.windowMs)),
    input.ip ? repo.countLoginTokens({ ip: input.ip }, new Date(now.getTime() - PER_IP.windowMs)) : 0,
  ]);
  if (byEmail >= PER_EMAIL.count || byIp >= PER_IP.count) return "limited";

  if (!isAllowed(email)) {
    console.info(`[formic] no sign-in link sent: ${email} is not on FORMIC_ALLOWED_USERS.`);
    return "sent";
  }

  const token = randomBytes(32).toString("base64url");
  await repo.createLoginToken({
    email,
    tokenHash: hashToken(token),
    next: input.next,
    ip: input.ip || null,
    expiresAt: new Date(now.getTime() + LINK_MS),
  });
  await send.sendSignIn({ to: email, link: input.linkFor(token), minutes: LINK_MINUTES });
  return "sent";
}

export type VerifyResult =
  | { ok: true; user: UserRecord; next: string }
  | { ok: false; error: string };

/** Spends a sign-in link and returns the person it signs in, creating their account the first time. */
export async function verifyEmailSignIn(token: unknown, now = new Date()): Promise<VerifyResult> {
  const expired = { ok: false as const, error: "That sign-in link has expired or was already used. Ask for a new one." };
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return expired;

  const repo = repository();
  const spent = await repo.spendLoginToken(hashToken(token), now);
  if (!spent) return expired;
  if (!isAllowed(spent.email)) {
    return { ok: false, error: `${spent.email} is not on this Formic's list of allowed users. Ask whoever runs it to add it to FORMIC_ALLOWED_USERS.` };
  }

  const existing = await repo.userByEmail(spent.email);
  if (existing) return { ok: true, user: existing, next: spent.next };

  const user = await firstSignIn(() =>
    repo.createEmailUser({ email: spent.email, login: handleFor(spent.email) }).catch(async (e) => {
      // Two links for one new address, spent at once: the other made the account.
      const raced = await repo.userByEmail(spent.email);
      if (raced) return raced;
      throw e;
    }),
  );
  return { ok: true, user, next: spent.next };
}

/** A display handle from the address: its local part, kept to what a username may hold. */
export function handleFor(email: string): string {
  const local = email.split("@")[0] ?? "";
  const handle = local
    .toLowerCase()
    .replace(/\+.*$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39);
  return handle || "member";
}
