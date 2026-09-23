import { afterEach, describe, expect, it, vi } from "vitest";
import { open, seal } from "./vault";

afterEach(() => vi.unstubAllEnvs());

describe("vault", () => {
  it("round-trips a key without storing it in the clear", () => {
    vi.stubEnv("FORMIC_SECRET", "one");
    const sealed = seal("sk-ant-secret");
    expect(sealed).not.toContain("sk-ant-secret");
    expect(open(sealed)).toBe("sk-ant-secret");
  });

  it("cannot open a key sealed under another secret", () => {
    vi.stubEnv("FORMIC_SECRET", "one");
    const sealed = seal("sk-ant-secret");
    vi.stubEnv("FORMIC_SECRET", "two");
    expect(open(sealed)).toBeNull();
  });

  it("rejects anything that is not a sealed value", () => {
    expect(open("sk-ant-plain")).toBeNull();
  });
});
