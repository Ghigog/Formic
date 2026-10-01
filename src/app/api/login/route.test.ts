import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { gatePassword } = vi.hoisted(() => ({ gatePassword: vi.fn() }));

vi.mock("@/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  gatePassword,
}));

const { POST } = await import("./route");
const { clearBuckets } = await import("@/lib/rate-limit");

beforeEach(() => {
  clearBuckets();
  gatePassword.mockReturnValue("sesame");
});

afterEach(() => vi.unstubAllEnvs());

function attempt(): Promise<Response> {
  const form = new FormData();
  form.set("password", "wrong");
  form.set("next", "/");
  return POST(
    new NextRequest("http://localhost/api/login", { method: "POST", body: form }),
  );
}

describe("POST /api/login", () => {
  it("lets ten wrong passwords through and refuses the eleventh", async () => {
    // Pin the clock so the calls cannot straddle a one-minute window boundary.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      for (let i = 0; i < 10; i++) {
        // A wrong password lands back on /login; only the count matters here.
        const res = await attempt();
        expect(res.headers.get("location")).toContain("/login");
      }

      const res = await attempt();
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(/[Tt]oo many/) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the count over in the next window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      for (let i = 0; i < 10; i++) await attempt();
      expect((await attempt()).status).toBe(429);

      vi.setSystemTime(new Date("2025-01-01T00:01:00Z"));
      expect((await attempt()).headers.get("location")).toContain("/login");
    } finally {
      vi.useRealTimers();
    }
  });
});
