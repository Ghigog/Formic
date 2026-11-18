import { describe, expect, it } from "vitest";
import { classifyFailure } from "./classify";

describe("classifyFailure", () => {
  it.each([
    "npm ERR! code ECONNRESET",
    "curl: (6) Could not resolve host: registry.npmjs.org",
    "The runner has received a shutdown signal.",
    "Error: getaddrinfo EAI_AGAIN registry.npmjs.org",
  ])("re-runs on an infrastructure failure: %s", (log) => {
    expect(classifyFailure(log).rerun).toBe(true);
  });

  it("does not re-run on a failing assertion", () => {
    expect(classifyFailure("AssertionError: expected 2 to be 3").rerun).toBe(false);
  });

  it("does not re-run without a log", () => {
    expect(classifyFailure(null).rerun).toBe(false);
  });

  it("re-runs a test named in the unreliable list", () => {
    const verdict = classifyFailure("FAIL flaky.test.ts > drags\nAssertionError", ["flaky.test.ts > drags"]);
    expect(verdict).toEqual({ rerun: true, reason: "flaky.test.ts > drags is a known-unreliable test" });
  });
});
