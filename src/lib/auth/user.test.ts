import { describe, expect, it } from "vitest";
import { CURRENT_TERMS_VERSION, needsTermsAcceptance } from "./user";
import type { UserRecord } from "@/lib/db/repository";

function user(termsAcceptedVersion: string | null): UserRecord {
  return {
    id: "u1",
    githubId: 1,
    login: "octo",
    name: null,
    avatarUrl: null,
    githubTokenCipher: null,
    githubTokenExpiresAt: null,
    githubRefreshCipher: null,
    githubRefreshExpiresAt: null,
    e2bKeyCipher: null,
    e2bKeyHint: null,
    anthropicKeyCipher: null,
    anthropicKeyHint: null,
    termsAcceptedVersion,
  };
}

describe("needsTermsAcceptance", () => {
  it("is true for someone who has never accepted", () => {
    expect(needsTermsAcceptance(user(null))).toBe(true);
  });

  it("is true for someone on an older version", () => {
    expect(needsTermsAcceptance(user("2020-01-01"))).toBe(true);
  });

  it("is false once the current version is accepted", () => {
    expect(needsTermsAcceptance(user(CURRENT_TERMS_VERSION))).toBe(false);
  });
});
