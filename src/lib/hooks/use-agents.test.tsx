import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { AgentPreset } from "@/lib/domain/entities";
import { useAgents } from "./use-agents";

afterEach(() => vi.unstubAllGlobals());

const preset = (id: string, name: string) => ({ id, name }) as unknown as AgentPreset;

describe("useAgents", () => {
  it("returns the agents it was mounted with", () => {
    const { result } = renderHook(() => useAgents([preset("a", "Coder")], { in_progress: "a" }));
    expect(result.current.presets.map((p) => p.name)).toEqual(["Coder"]);
    expect(result.current.columns).toEqual({ in_progress: "a" });
  });

  it("loads fresh usage from a stubbed fetch", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      Response.json({ usage: { a: { tokensIn: 3, tokensOut: 4 } }, window: { kind: "reset", since: "2026-01-01", timezone: null } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useAgents([preset("a", "Coder")], {}));
    await act(() => result.current.refreshUsage());
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/agents");
    expect(result.current.usage.a).toEqual({ tokensIn: 3, tokensOut: 4 });
    expect(result.current.window.kind).toBe("reset");
  });

  it("adds a saved preset to the list", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ preset: preset("b", "Reviewer") }));
    const { result } = renderHook(() => useAgents([preset("a", "Coder")], {}));
    await act(() => result.current.save({ name: "Reviewer" } as never, {}));
    expect(result.current.presets.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("keeps the saved agent but says so when its token did not reach the repository's secret", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        preset: preset("a", "PM"),
        secret: { saved: false, name: "FORMIC_CLAUDE_CODE_TOKEN", repo: "me/app", reason: "GitHub said no (403)" },
      }),
    );
    const { result } = renderHook(() => useAgents([preset("a", "Old PM")], {}));
    let error: unknown;
    await act(async () => {
      await result.current.save({ name: "PM" } as never, { id: "a" }).catch((e: unknown) => (error = e));
    });
    expect(result.current.presets.map((p) => p.name)).toEqual(["PM"]);
    expect(String(error)).toContain("could not put the token in me/app's FORMIC_CLAUDE_CODE_TOKEN secret (GitHub said no (403))");
  });
});
