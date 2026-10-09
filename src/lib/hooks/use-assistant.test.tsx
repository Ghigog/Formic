import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAssistant } from "./use-assistant";

afterEach(() => vi.unstubAllGlobals());

const message = (status: "pending" | "failed") => ({
  id: "m",
  role: "assistant",
  content: status === "failed" ? "Stopped." : "",
  status,
  proposals: [],
});

describe("useAssistant stop", () => {
  it("cancels the pending answer after the POST has returned", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(method);
      const status = method === "POST" ? "pending" : method === "PATCH" ? "failed" : null;
      return Response.json({ presetId: null, messages: status ? [message(status)] : [] });
    });
    const { result } = renderHook(() => useAssistant(true));
    await act(() => result.current.ask("hi"));
    expect(result.current.pending).toBe(true);
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(calls).toContain("PATCH");
  });
});
