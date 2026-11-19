import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELPER_SCRIPT, PROXY_SCRIPT } from "./proxy-script";

/** The proxy really runs, under Node, in front of a real little server. */
const dir = mkdtempSync(join(tmpdir(), "playtest-proxy-"));
writeFileSync(join(dir, "proxy.js"), PROXY_SCRIPT);
writeFileSync(join(dir, "helper.js"), HELPER_SCRIPT);
writeFileSync(join(dir, "html-to-image.js"), "window.htmlToImage = {};");
const site = join(dir, "site");
mkdirSync(site);
writeFileSync(join(site, "index.html"), "<!doctype html><html><head><title>t</title></head><body>game</body></html>");
writeFileSync(join(site, "game.wasm"), "wasm");

let app: Server;
let appPort = 0;
const procs: ChildProcess[] = [];

async function startProxy(port: number, env: Record<string, string>): Promise<string> {
  const p = spawn(process.execPath, [join(dir, "proxy.js")], {
    env: { ...process.env, PROXY_PORT: String(port), FORMIC_ORIGIN: "https://formic.test", ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  procs.push(p);
  await new Promise<void>((resolve) => p.stdout!.once("data", () => resolve()));
  return `http://127.0.0.1:${port}`;
}

beforeAll(async () => {
  app = createServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" });
      res.end(`<html><head></head><body>host=${req.headers.host}</body></html>`);
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    }
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  appPort = (app.address() as { port: number }).port;
});

afterAll(() => {
  for (const p of procs) p.kill();
  app.close();
});

describe("playtest proxy", () => {
  it("forwards to the product with its own Host, adds the helper, and drops frame blockers", async () => {
    const base = await startProxy(18484, { APP_PORT: String(appPort) });
    const res = await fetch(`${base}/page`);
    const html = await res.text();
    expect(html).toContain(`host=localhost:${appPort}`);
    expect(html).toMatch(/<head><script src="\/__formic\/helper\.js"><\/script>/);
    expect(res.headers.get("x-frame-options")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(await (await fetch(`${base}/api`)).json()).toEqual({ ok: true });
    expect((await fetch(`${base}/__formic/ready`)).status).toBe(200);
  });

  it("serves a static export, with the helper, and only the formic origin baked in", async () => {
    const base = await startProxy(18485, { STATIC_DIR: site });
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('<head><script src="/__formic/helper.js"></script><title>');
    const wasm = await fetch(`${base}/game.wasm`);
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect((await fetch(`${base}/../proxy.js`)).status).not.toBe(200);
    const helper = await (await fetch(`${base}/__formic/helper.js`)).text();
    expect(helper).toContain('var ORIGIN = "https://formic.test";');
    expect(helper).toContain('"/__formic/html-to-image.js"');
    expect(await (await fetch(`${base}/__formic/html-to-image.js`)).text()).toBe("window.htmlToImage = {};");
    expect((await fetch(`${base}/__formic/ready`)).status).toBe(200);
  });
});
