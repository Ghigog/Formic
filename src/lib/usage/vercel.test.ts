import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { fetchVercelUsage, parseCosts, vercelConfigured } from "./vercel";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const costs = {
  queriedAt: "2026-01-02T00:00:00Z",
  metrics: [
    { slug: "gross_cost" },
    { slug: "cpu", unit: { kind: "duration", plural: "seconds" } },
    { slug: "inv", unit: { name: "calls" } },
    { slug: "mem", unit: { singular: "GB-hour" } },
  ],
  results: {
    times: ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"],
    dimensionsMeta: { product: { values: { p4: { title: "Function Invocations" } } } },
    views: {
      byProduct: {
        results: [
          { dimensionValues: { product: "Active CPU" }, metrics: ["gross_cost", "cpu"], values: [[1, 7200], [1, null]] },
          { dimensionValues: { product: "p4" }, metrics: ["gross_cost", "inv"], values: [[0, 5]] },
          { dimensionValues: { product: "Provisioned Memory" }, metrics: ["mem", "gross_cost"], values: [[2, 1]] },
          { dimensionValues: { product: "Sandbox Active CPU" }, metrics: ["gross_cost", "cpu"], values: [[1, 9]] },
          { dimensionValues: { product: "Active CPU" }, metrics: ["gross_cost"], values: [] },
          { dimensionValues: {}, metrics: [] },
          { dimensionValues: { product: "Bandwidth" }, metrics: ["gross_cost", "x"] },
        ],
      },
    },
  },
};

describe("parseCosts", () => {
  it("sums each allowance per UTC day and converts durations to hours", () => {
    const out = parseCosts(costs);
    expect(out.days["2026-01-01"]).toEqual({ cpuHours: 2, invocations: 5, memoryGbHours: 2 });
    expect(out.days["2026-01-02"]).toBeUndefined();
    expect(out.units.cpuHours).toBe("seconds");
    expect(out.units.invocations).toBe("calls");
    expect(out.units.memoryGbHours).toBe("GB-hour");
  });

  it("copes with an empty answer", () => {
    const out = parseCosts({});
    expect(out.days).toEqual({});
    expect(typeof out.queriedAt).toBe("string");
  });

  it("reads other duration units and an unnamed unit", () => {
    const mk = (unit: object | undefined) =>
      parseCosts({
        metrics: unit ? [{ slug: "c", unit }] : [],
        results: {
          times: ["2026-01-01T00:00:00Z"],
          views: { byProduct: { results: [{ dimensionValues: { product: "active_cpu" }, metrics: ["gross_cost", "c"], values: [[0, 60]] }] } },
        },
      });
    expect(mk({ kind: "duration", name: "ms" }).days["2026-01-01"]!.cpuHours).toBeCloseTo(60 / 3_600_000);
    expect(mk({ kind: "duration", name: "minutes" }).days["2026-01-01"]!.cpuHours).toBe(1);
    expect(mk({ kind: "duration", name: "hours" }).days["2026-01-01"]!.cpuHours).toBe(60);
    expect(mk(undefined).units.cpuHours).toBe("(none given)");
  });
});

describe("vercelConfigured", () => {
  it("needs a non-blank token", () => {
    vi.stubEnv("FORMIC_VERCEL_TOKEN", "  ");
    expect(vercelConfigured()).toBe(false);
    vi.stubEnv("FORMIC_VERCEL_TOKEN", "t");
    expect(vercelConfigured()).toBe(true);
  });
});

describe("fetchVercelUsage", () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  it("reads the billing period then the costs, scoped to the team", async () => {
    vi.stubEnv("FORMIC_VERCEL_TOKEN", "t");
    vi.stubEnv("FORMIC_VERCEL_TEAM_ID", "team 1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        ok({
          billing: {
            subscriptions: [
              { frequency: { interval: "month", intervalCount: 1 }, period: { start: "2025-12-15T00:00:00Z", end: "2026-01-15T00:00:00Z" } },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(ok(costs));
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchVercelUsage("2026-01-01", Date.parse("2026-01-03T00:00:00Z"));
    expect(out.period).toEqual({ start: "2025-12-15", end: "2026-01-15" });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/v2/teams/team%201");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).from).toBe("2025-12-15T00:00:00.000Z");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("teamId=team+1");
  });

  it("falls back to the plan period for a personal account, or none", async () => {
    vi.stubEnv("FORMIC_VERCEL_TOKEN", "t");
    vi.stubEnv("FORMIC_VERCEL_TEAM_ID", "");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ user: { billing: { period: { start: 0, end: "nope" } } } }))
      .mockResolvedValueOnce(ok({}));
    vi.stubGlobal("fetch", fetchMock);
    const out = await fetchVercelUsage("2026-01-01");
    expect(out.period).toBeNull();
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/v2/user");
  });

  it("throws when Vercel answers an error", async () => {
    vi.stubEnv("FORMIC_VERCEL_TOKEN", "t");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    await expect(fetchVercelUsage("2026-01-01")).rejects.toThrow("403");
  });
});
