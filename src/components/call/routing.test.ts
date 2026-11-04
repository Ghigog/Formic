import { describe, expect, it } from "vitest";
import { detectAddGuest, isHelloEveryone, resolveAddressee } from "./routing";

describe("call routing on the client", () => {
  it("knows a greeting to everyone", () => {
    expect(isHelloEveryone("Hello everyone")).toBe(true);
    expect(isHelloEveryone("hey everybody, how are we?")).toBe(true);
    expect(isHelloEveryone("hello architect")).toBe(false);
    expect(isHelloEveryone("everyone is late")).toBe(false);
  });
  it("brings a guest in and goes on with the last speaker", () => {
    expect(detectAddGuest("get the Reviewer in")).toBe("reviewer");
    expect(resolveAddressee("what about tests?", ["assistant", "reviewer"], "reviewer")).toBe("reviewer");
  });
});
