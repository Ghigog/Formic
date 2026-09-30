import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { clearBuckets, clientAddress, limit, limited } from ".";

function request(
  path: string,
  headers: Record<string, string> = {},
  method = "POST",
): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method, headers });
}

beforeEach(clearBuckets);

describe("clientAddress", () => {
  it("takes the last entry of a forwarded chain, which the proxy appends", () => {
    expect(
      clientAddress(request("/api/login", { "x-forwarded-for": "9.9.9.9, 5.6.7.8" })),
    ).toBe("5.6.7.8");
  });

  it("takes the address the proxy reports when no chain was forwarded", () => {
    expect(clientAddress(request("/api/login", { "x-real-ip": "6.6.6.6" }))).toBe("6.6.6.6");
  });

  it("falls back to a shared bucket when no proxy reported an address", () => {
    expect(clientAddress(request("/api/login"))).toBe("");
  });
});

describe("limited", () => {
  it("lets the first nine sign-in attempts through and refuses the tenth in the same minute", () => {
    const req = () => request("/api/login");
    for (let i = 0; i < 9; i++) {
      const res = limited(req(), limit(9, 60_000), "sign-in");
      expect(res).toBeNull();
    }
    expect(limited(req(), limit(9, 60_000), "sign-in")).toMatchObject({ status: 429 });
  });

  it("refuses a wrong-password burst on its own address, not the whole board's", () => {
    for (let i = 0; i < 9; i++) {
      expect(limited(request("/api/login"), limit(9, 60_000), "sign-in")).toBeNull();
    }
    const res = limited(request("/api/login"), limit(9, 60_000), "sign-in");
    expect(res).toMatchObject({ status: 429 });
    expect(res!.headers.get("retry-after")).toMatch(/^\d+$/);

    // A different address is still free: the lockout follows the address.
    expect(
      limited(request("/api/login", { "x-real-ip": "6.6.6.6" }), limit(9, 60_000), "sign-in"),
    ).toBeNull();
  });

  it("counts a window in whole minutes, so the lockout ends when it moves on", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      for (let i = 0; i < 9; i++) {
        expect(limited(request("/api/login"), limit(9, 60_000), "sign-in")).toBeNull();
      }
      expect(limited(request("/api/login"), limit(9, 60_000), "sign-in")).toMatchObject({
        status: 429,
      });

      vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
      expect(limited(request("/api/login"), limit(9, 60_000), "sign-in")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("buckets by name, so one route's limit does not eat another's", () => {
    for (let i = 0; i < 9; i++) {
      expect(limited(request("/api/login"), limit(9, 60_000), "sign-in")).toBeNull();
    }
    expect(limited(request("/api/login"), limit(9, 60_000), "sign-in")).toMatchObject({
      status: 429,
    });
    expect(
      limited(request("/api/auth/github/login"), limit(9, 60_000), "github-sign-in"),
    ).toBeNull();
  });
});
