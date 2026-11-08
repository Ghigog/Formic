import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { signingSecret } from "@/lib/auth/session";
import { configuredOrigin } from "@/lib/origin";

/**
 * The webhook a GitLab project sends Formic when its agent job finishes, so
 * a result is taken at once rather than at the board's next sweep.
 *
 * Its secret is derived from FORMIC_SECRET and the project's path: nothing
 * new to configure, and each project's token is its own, so one leaked
 * token speaks for one project only.
 */

export const GITLAB_HOOK_PATH = "/api/webhooks/gitlab";

export function gitlabHookToken(path: string): string {
  return createHmac("sha256", signingSecret()).update(`gitlab-hook:${path.toLowerCase()}`).digest("hex");
}

export function verifyGitlabHook(path: string, token: string | null): boolean {
  if (!token) return false;
  const want = Buffer.from(gitlabHookToken(path));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Where GitLab should send its job events, or null when this Formic has no public address. */
export function gitlabHookUrl(): string | null {
  const origin = configuredOrigin();
  return origin ? `${origin}${GITLAB_HOOK_PATH}` : null;
}
