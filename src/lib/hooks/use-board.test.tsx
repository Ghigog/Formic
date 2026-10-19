import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { BoardCard } from "@/lib/domain/entities";
import type { FormicEvent } from "@/lib/domain/events";
import type { AmbientStats } from "@/components/ui/ambient-drawer";

let emit: (event: FormicEvent, seq: number) => void = () => {};
vi.mock("./use-board-events", () => ({
  useBoardEvents: (onEvent: typeof emit) => {
    emit = onEvent;
    return "open";
  },
}));

import { useBoard } from "./use-board";

const card = (id: string, key: string) => ({ id, key, kind: "ticket", title: key }) as unknown as BoardCard;
const stats: AmbientStats = { activeSandboxes: 0, provider: "none", tokensIn: 0, tokensOut: 0, costCents: 0, logLines: [] };
const send = (event: object, seq = 1) => act(() => emit(event as FormicEvent, seq));

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => Response.json({ cards: [card("c2", "T-2")] }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useBoard", () => {
  it("folds events into cards, extras and stats", () => {
    const { result } = renderHook(() => useBoard([card("c1", "T-1")], stats));

    send({ type: "card.queen", cardId: "c1", kind: "ticket" });
    expect(result.current.cards[0]!.queen).toBe(true);

    send({ type: "ci.status", ticketId: "c1", state: "passing" });
    expect(result.current.extras.c1?.ci).toBe("passing");

    send({ type: "run.progress", ticketId: "c1", label: "Coding", fraction: 0.5 });
    expect(result.current.extras.c1?.progress).toEqual({ label: "Coding", fraction: 0.5 });

    send({ type: "run.usage", tokensIn: 10, tokensOut: 5, costCents: 3 });
    send({ type: "run.usage", tokensIn: 1, tokensOut: 1, costCents: 1 });
    expect(result.current.stats).toMatchObject({ tokensIn: 11, tokensOut: 6, costCents: 4 });

    send({ type: "run.log", runId: "r", ticketId: "c1", stream: "stdout", line: "hi" });
    expect(result.current.stats.logLines).toEqual([{ runId: "r", label: "T-1", stream: "stdout", line: "hi" }]);

    send({ type: "epic.prd", epicId: "e", delta: "a", done: false });
    send({ type: "epic.prd", epicId: "e", delta: "b", done: false });
    expect(result.current.prdStreams.e).toBe("ab");
  });

  it("refetches once when several events arrive within the debounce window", async () => {
    const { result } = renderHook(() => useBoard([card("c1", "T-1")], stats));
    const status = { type: "card.status", cardId: "c1", kind: "ticket", status: "coding" };

    send(status, 1);
    await act(() => vi.advanceTimersByTimeAsync(100));
    send({ type: "card.created", cardId: "c3", kind: "ticket" }, 2);
    send({ type: "run.finished" }, 3);
    expect(fetchMock).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(120));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/board", { cache: "no-store" });
    expect(result.current.cards.map((c) => c.id)).toEqual(["c2"]);
  });
});
