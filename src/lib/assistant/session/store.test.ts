import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";

vi.mock("server-only", () => ({}));

const { openFile, PM_SESSION_MAX_BYTES, sealFile, ciWhere } = await import("./store");

const pack = (text: string) => gzipSync(text).toString("base64");

describe("the session file at rest", () => {
  it("is sealed, never stored as it came, and opens again", () => {
    const file = pack('{"type":"user"}\n');
    const sealed = sealFile(file)!;
    expect(sealed.cipher).not.toContain(file);
    expect(sealed.bytes).toBe(Buffer.from(file, "base64").length);
    expect(openFile({ fileCipher: sealed.cipher })).toBe(file);
  });

  it("is refused above the cap, and when it is empty or not base64", () => {
    const big = Buffer.alloc(PM_SESSION_MAX_BYTES + 1).toString("base64");
    expect(sealFile(big)).toBeNull();
    expect(sealFile("")).toBeNull();
    expect(sealFile("not base64!")).toBeNull();
  });

  it("does not open when there is none, or under another secret", () => {
    expect(openFile({ fileCipher: null })).toBeNull();
    expect(openFile({ fileCipher: "v1.a.b.c" })).toBeNull();
  });

  it("runs in GitLab CI for a GitLab board, GitHub Actions otherwise", () => {
    expect(ciWhere("gitlab:group/app")).toBe("gitlab");
    expect(ciWhere("o/app")).toBe("actions");
  });
});
