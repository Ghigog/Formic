import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultKeyMissingError, open, seal, vaultProblem } from "./vault";

const DB_VARS = ["DATABASE_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL"];
beforeEach(() => {
  for (const name of ["FORMIC_SECRET", ...DB_VARS]) vi.stubEnv(name, "");
});
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

  it("keeps a fixed local key with no database and no secret", () => {
    expect(vaultProblem()).toBeNull();
    expect(open(seal("sk-local"))).toBe("sk-local");
  });

  it.each(DB_VARS)("refuses to seal with %s set and no secret", (name) => {
    vi.stubEnv(name, "postgres://u:p@h/db");
    expect(vaultProblem()).toContain("FORMIC_SECRET");
    expect(() => seal("sk")).toThrow(VaultKeyMissingError);
    expect(() => seal("sk")).toThrow(/FORMIC_SECRET/);
    expect(open("v1.a.b.c")).toBeNull();
  });

  it("does not use the database URL as key material", () => {
    vi.stubEnv("FORMIC_SECRET", "one");
    vi.stubEnv("DATABASE_URL", "postgres://a/db");
    const sealed = seal("sk");
    vi.stubEnv("DATABASE_URL", "postgres://b/db");
    expect(open(sealed)).toBe("sk");
  });
});
