import { describe, expect, it } from "vitest";
import { containsSecret, knownSecretValues, redact, redactDeep } from "./redact";
import type { EnvLike } from "./redact";

const ENV: EnvLike = {
  ANTHROPIC_API_KEY: "sk-ant-api03-ThisIsATestKeyValue0000",
  GITHUB_TOKEN: "ghp_TestTokenValue1234567890abcd",
  DATABASE_URL: "postgresql://formic:sup3rs3cretpw@db.internal:5432/formic",
};

describe("redact", () => {
  it("removes a known credential wherever it appears", () => {
    const line = `cloning with ${ENV.GITHUB_TOKEN} now`;
    expect(redact(line, [], ENV)).toBe("cloning with [redacted] now");
  });

  it("removes the password out of a connection string", () => {
    expect(redact("connecting as sup3rs3cretpw", [], ENV)).toBe(
      "connecting as [redacted]",
    );
  });

  it("keeps the shape of an authenticated clone URL readable", () => {
    const url = "https://x-access-token:ghp_Unknown000111222333444@github.com/a/b.git";
    expect(redact(url, [], {})).toBe(
      "https://[redacted]@github.com/a/b.git",
    );
  });

  it("catches token shapes this process does not hold", () => {
    const foreign = "leaked sk-ant-api03-SomeoneElsesKey99999 in a ticket";
    expect(redact(foreign, [], {})).toBe("leaked [redacted] in a ticket");
  });

  it("catches a GitHub fine-grained token", () => {
    const line = "token github_pat_11ABCDEFG0aaaaaaaaaaaa_bbbbbbbbbbbb";
    expect(redact(line, [], {})).toContain("[redacted]");
    expect(redact(line, [], {})).not.toContain("github_pat_11");
  });

  it("catches a bearer header", () => {
    const line = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345";
    expect(redact(line, [], {})).toBe("Authorization: [redacted]");
  });

  it("catches a private key block", () => {
    const line = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(redact(line, [], {})).toBe("[redacted]");
  });

  it("accepts an extra value supplied by the caller", () => {
    expect(redact("sandbox key abc12345678", ["abc12345678"], {})).toBe(
      "sandbox key [redacted]",
    );
  });

  it("ignores values too short to be a credential", () => {
    expect(redact("the value is abc", ["abc"], {})).toBe("the value is abc");
  });

  it("leaves clean text untouched", () => {
    const clean = "npm test passed in 4.2s";
    expect(redact(clean, [], ENV)).toBe(clean);
  });
});

describe("redactDeep", () => {
  it("scrubs nested strings in an event payload", () => {
    const payload = {
      runId: "run_1",
      lines: [`using ${ENV.GITHUB_TOKEN}`, "ok"],
      nested: { url: `https://x-access-token:${ENV.GITHUB_TOKEN}@github.com/a/b.git` },
      count: 3,
    };
    const out = redactDeep(payload, knownSecretValues(ENV));
    expect(out.lines[0]).toBe("using [redacted]");
    expect(out.nested.url).not.toContain("ghp_");
    expect(out.count).toBe(3);
  });
});

describe("containsSecret", () => {
  it("is a usable assertion for tests and guards", () => {
    expect(containsSecret(`x ${ENV.ANTHROPIC_API_KEY}`, ENV)).toBe(true);
    expect(containsSecret("nothing here", ENV)).toBe(false);
  });
});
