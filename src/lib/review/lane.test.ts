import { beforeEach, describe, expect, it } from "vitest";

import {
  inMergeLane,
  inTicketLane,
  mergeLaneDepth,
  resetMergeLanes,
} from "./lane";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("the merge lane", () => {
  beforeEach(resetMergeLanes);

  it("runs one merge at a time, in the order they arrived", async () => {
    const order: string[] = [];
    const first = deferred<void>();

    const a = inMergeLane("p", async () => {
      order.push("a:start");
      await first.promise;
      order.push("a:end");
    });
    const b = inMergeLane("p", async () => {
      order.push("b:start");
    });

    // b must not have started while a is still in flight.
    await Promise.resolve();
    expect(order).toEqual(["a:start"]);

    first.resolve();
    await Promise.all([a, b]);

    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("does not wedge the lane when a merge fails", async () => {
    const failed = inMergeLane("p", async () => {
      throw new Error("merge conflict");
    });

    await expect(failed).rejects.toThrow("merge conflict");
    await expect(inMergeLane("p", async () => "next")).resolves.toBe("next");
  });

  it("keeps separate projects out of each other's way", async () => {
    const held = deferred<void>();
    const blocked = inMergeLane("p1", () => held.promise);

    await expect(inMergeLane("p2", async () => "free")).resolves.toBe("free");

    held.resolve();
    await blocked;
  });

  it("reports how deep the lane is", async () => {
    const held = deferred<void>();
    const a = inMergeLane("p", () => held.promise);
    const b = inMergeLane("p", async () => {});

    expect(mergeLaneDepth("p")).toBe(2);

    held.resolve();
    await Promise.all([a, b]);
    expect(mergeLaneDepth("p")).toBe(0);
  });

  it("serialises reactions per ticket, so four checks do not open four sandboxes", async () => {
    let live = 0;
    let maxLive = 0;

    const work = async () => {
      live++;
      maxLive = Math.max(maxLive, live);
      await new Promise((r) => setTimeout(r, 1));
      live--;
    };

    await Promise.all([
      inTicketLane("t1", work),
      inTicketLane("t1", work),
      inTicketLane("t1", work),
      inTicketLane("t1", work),
    ]);

    expect(maxLive).toBe(1);
  });
});
