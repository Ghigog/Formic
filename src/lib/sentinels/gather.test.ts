import { describe, expect, it, vi } from "vitest";
import type { VcsClient } from "@/lib/vcs/types";
import { gatherEvidence } from "./gather";

function client(over: Partial<VcsClient> = {}): VcsClient {
  return {
    branchHead: vi.fn(async () => "abc1234"),
    checksFor: vi.fn(async () => [
      { id: 7, name: "test", status: "completed" as const, conclusion: "failure" as const, detailsUrl: null },
    ]),
    checkLog: vi.fn(async () => ({ name: "test", summary: "boom", annotations: [] })),
    branchRuns: vi.fn(async () => []),
    readFile: vi.fn(async (path: string) =>
      path === "package.json" ? JSON.stringify({ dependencies: { a: "1" } }) : null,
    ),
    ...over,
  } as unknown as VcsClient;
}

describe("gatherEvidence", () => {
  it("gathers nothing for a role that needs nothing", async () => {
    const c = client();
    expect(await gatherEvidence({ client: c, branch: "main", files: [] })).toEqual({ sections: [], images: [] });
    expect(c.branchHead).not.toHaveBeenCalled();
  });

  it("reads the base branch's checks and the failed ones' logs", async () => {
    const c = client();
    const {
      sections: [text],
    } = await gatherEvidence({ client: c, branch: "main", files: [], kinds: ["ci"] });
    expect(c.checksFor).toHaveBeenCalledWith("abc1234");
    expect(c.checkLog).toHaveBeenCalledWith(7);
    expect(text).toContain('Failed check "test":\nboom');
  });

  it("reads the lockfile only when it is one it can parse", async () => {
    const c = client();
    await gatherEvidence({ client: c, branch: "main", files: ["package.json", "yarn.lock"], kinds: ["deps"] });
    expect(c.readFile).toHaveBeenCalledTimes(1);
    await gatherEvidence({ client: c, branch: "main", files: ["package.json", "package-lock.json"], kinds: ["deps"] });
    expect(c.readFile).toHaveBeenCalledWith("package-lock.json", "main");
  });

  it("says what GitHub would not give, instead of failing the audit", async () => {
    const c = client({ branchRuns: vi.fn(async () => Promise.reject(new Error("Resource not accessible"))) });
    const { sections } = await gatherEvidence({ client: c, branch: "main", files: [], kinds: ["ci"] });
    expect(sections).toEqual(["CI results could not be read from GitHub: Resource not accessible"]);
  });
});

describe("gatherEvidence from the code and from CI", () => {
  const snapshot = {
    truncated: false,
    files: new Map([
      ["src/a.ts", Buffer.from('import { b } from "./b";\n')],
      ["src/b.ts", Buffer.from("export const b = 1;\n")],
      ["logo.bin", Buffer.from([1, 0, 2])],
    ]),
  };

  it("works out imports and untested code from the snapshot", async () => {
    const { sections } = await gatherEvidence({ client: client(), branch: "main", files: ["src/a.ts", "src/b.ts"], kinds: ["imports", "untested"], snapshot });
    expect(sections[0]).toContain("- src/b.ts: imported by 1");
    expect(sections[1]).toContain("0 test files; 2 source files, of which 2");
  });

  it("says so when there is no snapshot to work from", async () => {
    const { sections } = await gatherEvidence({ client: client(), branch: "main", files: [], kinds: ["imports"] });
    expect(sections[0]).toBe("Import map: The repository could not be downloaded whole, so this was not worked out.");
  });

  it("hands over screenshots and says where CI's facts came from", async () => {
    const c = client({
      artifacts: vi.fn(async () => ({
        runUrl: "https://github.com/o/r/actions/runs/9",
        files: new Map([
          ["sentinel-evidence/screens/board.png", Buffer.from([1])],
          ["sentinel-evidence/bundle.json", Buffer.from(JSON.stringify({ totalBytes: 2048 }))],
        ]),
      })),
    });
    const { sections, images } = await gatherEvidence({ client: c, branch: "main", files: [], kinds: ["bundle", "screens", "coverage"] });
    expect(c.artifacts).toHaveBeenCalledOnce();
    expect(sections[0]).toContain("From CI artifacts (https://github.com/o/r/actions/runs/9):\nClient JavaScript shipped: 2.0 kB");
    expect(sections[1]).toContain("1 screenshots from CI");
    expect(sections[2]).toBe("Coverage: the CI artifacts at https://github.com/o/r/actions/runs/9 hold none.");
    expect(images.map((i) => i.name)).toEqual(["sentinel-evidence/screens/board.png"]);
  });

  it("points at the docs when CI uploads nothing", async () => {
    const c = client({ artifacts: vi.fn(async () => null) });
    const { sections } = await gatherEvidence({ client: c, branch: "main", files: [], kinds: ["axe"] });
    expect(sections[0]).toMatch(/^Accessibility scans: no finished run on main uploaded an artifact .* docs\/sentinels\.md/);
  });
});
