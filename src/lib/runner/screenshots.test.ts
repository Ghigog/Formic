import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MAX_COUNT,
  screenshotSection,
  screenshotStep,
  screenshotUrl,
  skippedScreenshots,
  withoutScreenshotTrailers,
} from "./screenshots";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("data")]);

/** Runs the step in a throwaway repository with the given files staged. */
function run(files: Record<string, Buffer | string>) {
  const dir = mkdtempSync(join(tmpdir(), "shots-"));
  const sh = (cmd: string) => execFileSync("bash", ["-ec", cmd], { cwd: dir, env: { ...process.env, TICKET: "T-1", FORMIC_SUMMARY: join(dir, "summary") }, encoding: "utf8" });
  sh("git init -q && git config user.email a@b && git config user.name n && echo > x && git add x && git commit -qm init");
  writeFileSync(join(dir, "summary"), "T-1: done\n");
  mkdirSync(join(dir, ".formic/screenshots"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, ".formic/screenshots", name), body);
  sh(screenshotStep());
  const staged = sh("git diff --cached --name-only").split("\n").filter(Boolean);
  return { staged, summary: readFileSync(join(dir, "summary"), "utf8"), dir };
}

describe("screenshotStep", () => {
  it("stages PNGs under docs/screenshots/<ticket>/ and leaves the staging area out", () => {
    const r = run({ "a b.png": PNG });
    expect(r.staged).toEqual(["docs/screenshots/T-1/a-b.png"]);
    expect(existsSync(join(r.dir, ".formic/screenshots"))).toBe(false);
    expect(skippedScreenshots([r.summary])).toEqual([]);
  });

  it("skips a non-PNG, by name or by content", () => {
    const r = run({ "notes.txt": "hi", "fake.png": "not a png", "ok.PNG": PNG });
    expect(r.staged).toEqual(["docs/screenshots/T-1/ok.PNG"]);
    expect(skippedScreenshots([r.summary])).toEqual(["fake.png (not a PNG)", "notes.txt (not a PNG)"]);
  });

  it("skips a file over the size cap", () => {
    const r = run({ "big.png": Buffer.concat([PNG, Buffer.alloc(SCREENSHOT_MAX_BYTES)]) });
    expect(r.staged).toEqual([]);
    expect(skippedScreenshots([r.summary])[0]).toMatch(/^big\.png \(over \d+ bytes\)$/);
  });

  it("keeps the first screenshots up to the count cap and skips the rest", () => {
    const files = Object.fromEntries(Array.from({ length: SCREENSHOT_MAX_COUNT + 2 }, (_, i) => [`s${i}.png`, PNG]));
    const r = run(files);
    expect(r.staged).toHaveLength(SCREENSHOT_MAX_COUNT);
    expect(skippedScreenshots([r.summary])).toHaveLength(2);
  });

  it("changes nothing when there are no screenshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "shots-"));
    writeFileSync(join(dir, "summary"), "T-1: done\n");
    execFileSync("bash", ["-ec", screenshotStep()], { cwd: dir, env: { ...process.env, TICKET: "T-1", FORMIC_SUMMARY: join(dir, "summary") } });
    expect(readFileSync(join(dir, "summary"), "utf8")).toBe("T-1: done\n");
  });
});

describe("screenshot links", () => {
  it("links a GitHub image by blob URL with ?raw=true", () => {
    expect(screenshotUrl("o/r", "formic/t-1", "docs/screenshots/T-1/a b.png")).toBe(
      "https://github.com/o/r/blob/formic/t-1/docs/screenshots/T-1/a%20b.png?raw=true",
    );
  });

  it("links a GitLab image by raw URL", () => {
    expect(screenshotUrl("gitlab:g/p", "b", "docs/screenshots/T-1/a.png")).toBe(
      "https://gitlab.com/g/p/-/raw/b/docs/screenshots/T-1/a.png",
    );
  });

  it("shows the images inline and says what was left out", () => {
    const body = screenshotSection({
      repoFullName: "o/r",
      branch: "b",
      files: ["src/x.ts", "docs/screenshots/T-1/a.png"],
      skipped: ["notes.txt (not a PNG)"],
    });
    expect(body).toContain("![a.png](https://github.com/o/r/blob/b/docs/screenshots/T-1/a.png?raw=true)");
    expect(body).toContain("Left out: `notes.txt (not a PNG)`");
  });

  it("writes nothing when there were no screenshots", () => {
    expect(screenshotSection({ repoFullName: "o/r", branch: "b", files: ["src/x.ts"], skipped: [] })).toBe("");
  });

  it("strips its trailers from the commit text", () => {
    expect(withoutScreenshotTrailers("Did it.\n\nFormic-Screenshot-Skipped: a.txt (not a PNG)\n")).toBe("Did it.");
  });
});
