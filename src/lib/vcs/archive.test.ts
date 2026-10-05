import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { untar, unzip } from "./archive";

/** A folder of files, as GitHub would archive a repository. */
function tree(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "formic-archive-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, "owner-repo-abc123", path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

async function* chunked(bytes: Buffer, size: number) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

const longPath = `src/${"deep/".repeat(30)}file.ts`;
const files = {
  "README.md": "# hello\n",
  "src/a.ts": "export const a = 1;\n",
  [longPath]: "export const deep = true;\n",
  "big.bin": Buffer.alloc(5000, 7),
};

/**
 * macOS writes an AppleDouble `._name` entry beside every file it archives, so
 * a tarball made here carries entries no GitHub archive ever has. Turning that
 * off makes the fixture match what the reader is really handed.
 */
const tarEnv = { ...process.env, COPYFILE_DISABLE: "1" };

/**
 * Whether this machine's tar can write a format at all. macOS ships BSD tar,
 * which cannot write `gnu` ("No such format 'gnu'"), so that fixture can only
 * be made where GNU tar is. The subject here is reading an archive, not the
 * platform's tar — a format this tar cannot make is skipped rather than failed,
 * and CI, on Linux, still runs both.
 */
function tarCanWrite(format: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), "formic-tar-"));
  try {
    execFileSync("tar", [`--format=${format}`, "-cf", join(dir, "can.tar"), "-C", dir, "."], {
      stdio: "ignore",
      env: tarEnv,
    });
    return true;
  } catch {
    return false;
  }
}

describe("untar", () => {
  for (const format of ["pax", "gnu"]) {
    it.skipIf(!tarCanWrite(format))(`reads a ${format} tarball in odd-sized chunks, long paths and all`, async () => {
      const root = tree(files);
      const out = join(root, "repo.tar.gz");
      execFileSync("tar", [`--format=${format}`, "-czf", out, "-C", root, "owner-repo-abc123"], { env: tarEnv });
      const tar = gunzipSync(readFileSync(out));

      const { files: got, truncated } = await untar(chunked(tar, 333), (p) => !p.endsWith(".bin"), 1_000_000);
      expect(truncated).toBe(false);
      expect([...got.keys()].sort()).toEqual(["README.md", "src/a.ts", longPath].sort());
      expect(got.get(longPath)?.toString()).toBe("export const deep = true;\n");
      expect(got.get("README.md")?.toString()).toBe("# hello\n");
    });
  }

  it("stops keeping once the budget is spent, and says so", async () => {
    const root = tree(files);
    const out = join(root, "repo.tar");
    execFileSync("tar", ["-cf", out, "-C", root, "owner-repo-abc123"], { env: tarEnv });
    const { files: got, truncated } = await untar(chunked(readFileSync(out), 4096), () => true, 100);
    expect(truncated).toBe(true);
    expect([...got.values()].reduce((n, b) => n + b.length, 0)).toBeLessThanOrEqual(100);
  });
});

describe("unzip", () => {
  it("reads stored and deflated entries", () => {
    const root = tree({ "report/axe.json": JSON.stringify({ violations: [] }), "shots/board.png": Buffer.alloc(3000, 1) });
    const out = join(root, "a.zip");
    execFileSync("zip", ["-qr", out, "."], { cwd: join(root, "owner-repo-abc123") });
    const { files: got } = unzip(readFileSync(out), () => true, 1_000_000);
    expect(got.get("report/axe.json")?.toString()).toBe('{"violations":[]}');
    expect(got.get("shots/board.png")?.length).toBe(3000);
  });

  it("refuses what is not a zip", () => {
    expect(() => unzip(Buffer.from("nope"), () => true, 10)).toThrow(/Not a zip/);
  });
});
