import { describe, expect, it } from "vitest";
import { callContext, detectAddGuest, resolveAddressee } from "./routing";

describe("resolveAddressee", () => {
  it("picks a guest named at the start", () => {
    expect(resolveAddressee("Architect, how should we split this?", ["assistant", "architect"])).toBe("architect");
  });
  it("picks an @mentioned guest", () => {
    expect(resolveAddressee("what do you think @coder?", ["assistant", "coder"])).toBe("coder");
  });
  it("picks a guest greeted by name, or named last, the way people talk on a call", () => {
    const on = ["assistant", "architect", "coder", "sentinel:tester"] as const;
    expect(resolveAddressee("Hello architect. What's on the docket today?", on)).toBe("architect");
    expect(resolveAddressee("Good morning, Coder!", on)).toBe("coder");
    expect(resolveAddressee("How's the latest audit looking, professor O'Chumley?", on)).toBe("sentinel:tester");
    expect(resolveAddressee("What's the status, worker?", on)).toBe("coder");
    expect(resolveAddressee("I have a new feature request. Are you listening architect?", on)).toBe("architect");
    expect(resolveAddressee("Skip it", on)).toBe("assistant");
  });
  it("goes on with whoever spoke last when the message names nobody", () => {
    expect(resolveAddressee("Yes. What's the status?", ["assistant", "coder"], "coder")).toBe("coder");
    expect(resolveAddressee("Yes. What's the status?", ["assistant", "coder"], null)).toBe("assistant");
  });
  it("defaults to the assistant", () => {
    expect(resolveAddressee("how is the board?", ["assistant", "architect"])).toBe("assistant");
    expect(resolveAddressee("Coder, hi", ["assistant", "architect"])).toBe("assistant");
  });
});

describe("detectAddGuest", () => {
  it("detects asking for a guest", () => {
    expect(detectAddGuest("get the Coder in")).toBe("coder");
    expect(detectAddGuest("please bring in the Reviewer")).toBe("reviewer");
    expect(detectAddGuest("Get the worker on the phone")).toBe("coder");
    expect(detectAddGuest("Bring old professor chumly on the phone")).toBe("sentinel:tester");
  });
  it("returns null otherwise", () => {
    expect(detectAddGuest("the Coder is slow")).toBeNull();
    expect(detectAddGuest("get me a summary")).toBeNull();
  });
});

describe("callContext", () => {
  it("holds the agenda, board snapshot and the call so far", () => {
    const out = callContext(
      { title: "Sync", agenda: "Plan the release" },
      "BOARD-SNAP",
      [
        { role: "user", guestId: null, content: "hello" },
        { role: "assistant", guestId: "architect", content: "hi there" },
      ],
    );
    expect(out).toContain("Plan the release");
    expect(out).toContain("BOARD-SNAP");
    expect(out).toContain("Person: hello");
    expect(out).toContain("Architect: hi there");
  });
});
