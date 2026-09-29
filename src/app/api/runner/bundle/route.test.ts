import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLoopBundleDir } from "@/lib/runner/bundle";
import { loopBundleUrl } from "@/lib/runner/runner";
import { resetEnvCache } from "@/lib/secrets/env";

const { GET } = await import("./route");

/**
 * The address a run fetches its loop entry from. Signed like the report
 * endpoint: a job is the only thing that can use it, and only while its card
 * waits on it.
 */

const CODE = "// the loop entry\nexport const built = true;\n";
const COMMIT = "abcdef1234567890abcdef1234567890abcdef12";

beforeEach(() => {
  vi.stubEnv("FORMIC_SECRET", "test-secret");
  vi.stubEnv("FORMIC_URL", "https://formic.example");
  resetEnvCache();
});

afterEach(() => {
  setLoopBundleDir(null);
  vi.unstubAllEnvs();
  resetEnvCache();
});

/** A built bundle, where the route will look for it. */
async function builtBundle(code = CODE) {
  const dir = await mkdtemp(path.join(tmpdir(), "formic-bundle-"));
  await writeFile(path.join(dir, "loop-entry.mjs"), code);
  await writeFile(
    path.join(dir, "loop-entry.json"),
    JSON.stringify({ commit: COMMIT, builtAt: "2026-09-29T00:00:00.000Z", bytes: code.length }),
  );
  setLoopBundleDir(dir);
}

/** The route's own path and query, as the job would call it. */
function signed(url: string): NextRequest {
  return new NextRequest(`http://localhost${url.slice("https://formic.example".length)}`);
}

describe("GET /api/runner/bundle", () => {
  it("serves the built entry to the job it was signed for", async () => {
    await builtBundle();
    const job = "card-1--abc";
    const url = loopBundleUrl(job, 1_700_000_000_000)!;

    const res = await GET(signed(url));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Which commit this is, told twice: here, and inside the file.
    expect(res.headers.get("x-formic-commit")).toBe(COMMIT);
    expect(await res.text()).toBe(CODE);
  });

  it("refuses a tampered token, and another job's", async () => {
    await builtBundle();
    const url = new URL(loopBundleUrl("card-1--abc", 1_700_000_000_000)!);

    const tampered = new URL(url);
    tampered.searchParams.set("token", "0".repeat(64));
    expect((await GET(signed(tampered.toString()))).status).toBe(403);

    // The same token, claimed by a different job: not this job's payload.
    const other = new URL(url);
    other.searchParams.set("job", "card-2--def");
    expect((await GET(signed(other.toString()))).status).toBe(403);

    // No token at all.
    expect((await GET(new NextRequest("http://localhost/api/runner/bundle?job=x&since=1"))).status).toBe(403);
  });

  it("says so, rather than serving nothing, when the build had no bundle", async () => {
    setLoopBundleDir(await mkdtemp(path.join(tmpdir(), "formic-no-bundle-")));
    const url = loopBundleUrl("card-1--abc", 1_700_000_000_000)!;

    const res = await GET(signed(url));

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("no loop bundle") });
  });
});
