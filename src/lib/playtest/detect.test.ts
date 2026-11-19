import { describe, expect, it } from "vitest";
import { PLAYTEST_SCRIPT, UNSUPPORTED, detect, godotMinor, portFromLine, webPresetName } from "./detect";

const base = { packageJson: null, godotVersion: null, exportPresets: null };

describe("detect", () => {
  it("prefers the repository's own playtest script", () => {
    const r = detect({ ...base, files: [PLAYTEST_SCRIPT, "project.godot", "package.json"], packageJson: "{}" });
    expect(r.ok && r.plan.kind).toBe("script");
    expect(r.ok && r.plan.serve).toBe(`bash ${PLAYTEST_SCRIPT}`);
  });

  it("exports a Godot 4.3+ game single-threaded and serves the files", () => {
    const r = detect({ ...base, files: ["project.godot"], godotVersion: "4.3.stable.official.77dcf97d8" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.kind).toBe("godot");
    expect(r.plan.serve).toBeNull();
    expect(r.plan.staticDir).toBe("build/playtest-web");
    // Only the Web template is read out of the archive, which is too big for the sandbox's disk.
    expect(r.plan.fetch).toContain("releases/download/4.3-stable/Godot_v4.3-stable_export_templates.tpz");
    expect(r.plan.fetch).toContain("export_templates/4.3.stable");
    expect(r.plan.fetch).toContain("templates/web_nothreads_release.zip");
    expect(r.plan.fetch).not.toMatch(/curl|unzip/);
    expect(r.plan.prepare).not.toContain("export_templates.tpz");
    expect(r.plan.prepare).toContain("variant/thread_support=false");
    expect(r.plan.prepare).toContain("--export-release 'Playtest Web'");
  });

  it("uses a Web preset the project already has", () => {
    const presets = '[preset.0]\n\nname="Windows"\nplatform="Windows Desktop"\n\n[preset.1]\n\nname="Browser"\nplatform="Web"\n';
    const r = detect({ ...base, files: ["project.godot"], godotVersion: "4.4.1.stable.official", exportPresets: presets });
    expect(r.ok && r.plan.prepare).toContain("--export-release 'Browser'");
    expect(r.ok && r.plan.prepare).not.toContain("FORMIC_PRESET");
  });

  it("explains a Godot that is too old for a single-threaded export", () => {
    const r = detect({ ...base, files: ["project.godot"], godotVersion: "4.2.2.stable.official" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("4.3 or newer");
  });

  it("runs a Node app's dev script with the lockfile's installer", () => {
    const pkg = JSON.stringify({ scripts: { dev: "vite", start: "node server.js" } });
    const npm = detect({ ...base, files: ["package.json", "package-lock.json"], packageJson: pkg });
    expect(npm.ok && npm.plan).toMatchObject({ kind: "node", prepare: "npm ci", serve: "npm run dev" });
    const pnpm = detect({ ...base, files: ["package.json", "pnpm-lock.yaml"], packageJson: pkg });
    expect(pnpm.ok && pnpm.plan.serve).toBe("pnpm run dev");
  });

  it("falls back to start, then to a static page, then says what it supports", () => {
    const start = detect({ ...base, files: ["package.json"], packageJson: JSON.stringify({ scripts: { start: "node ." } }) });
    expect(start.ok && start.plan).toMatchObject({ serve: "npm run start", prepare: "npm install" });
    const page = detect({ ...base, files: ["package.json", "index.html"], packageJson: JSON.stringify({ scripts: { lint: "x" } }) });
    expect(page.ok && page.plan).toMatchObject({ kind: "static", staticDir: "." });
    expect(detect({ ...base, files: ["index.html"] })).toMatchObject({ ok: true, plan: { kind: "static", prepare: null } });
    expect(detect({ ...base, files: ["main.go"] })).toEqual({ ok: false, reason: UNSUPPORTED, fault: "project" });
  });
});

describe("helpers", () => {
  it("reads Godot's version", () => {
    expect(godotMinor("4.3.stable.official.77dcf97d8")).toEqual({ major: 4, minor: 3, folder: "4.3.stable", tag: "4.3-stable" });
    expect(godotMinor("4.4.1.stable.official")).toMatchObject({ folder: "4.4.1.stable", tag: "4.4.1-stable" });
    expect(godotMinor("4.5.rc2.official")).toMatchObject({ tag: "4.5-rc2" });
    expect(godotMinor(null)).toBeNull();
  });

  it("finds a Web preset by name", () => {
    expect(webPresetName(null)).toBeNull();
    expect(webPresetName('[preset.0]\nname="Web"\nplatform="Web"\n')).toBe("Web");
    expect(webPresetName('[preset.0]\nname="Mac"\nplatform="macOS"\n')).toBeNull();
  });

  it("reads the port a dev server prints", () => {
    expect(portFromLine("  ➜  Local:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m")).toBe(5173);
    expect(portFromLine("- Local:        http://localhost:3000")).toBe(3000);
    expect(portFromLine("ready on http://0.0.0.0:8080")).toBe(8080);
    expect(portFromLine("compiled successfully")).toBeNull();
  });
});
