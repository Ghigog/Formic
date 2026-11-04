import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mailer, SignInEmail } from "@/lib/auth/mailer";

const { repository } = await import("@/lib/db");
const { setMailer } = await import("@/lib/auth/mailer");
const { SESSION_COOKIE, verifySession } = await import("@/lib/auth/session");
const { clearBuckets } = await import("@/lib/rate-limit");
const start = await import("./start/route");
const verify = await import("./verify/route");

const ORIGIN = "http://localhost:3000";

class Inbox implements Mailer {
  readonly name = "console" as const;
  sent: SignInEmail[] = [];
  async sendSignIn(mail: SignInEmail) {
    this.sent.push(mail);
  }
  tokenFor(to: string): string {
    const mail = [...this.sent].reverse().find((m) => m.to === to);
    if (!mail) throw new Error(`nothing sent to ${to}`);
    return new URL(mail.link).searchParams.get("token")!;
  }
}

let inbox: Inbox;

function form(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return body;
}

function post(path: string, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    body: form(fields),
    headers: { "sec-fetch-site": "same-origin", "x-real-ip": "203.0.113.9", ...headers },
  });
}

function cookiesOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const [k, ...v] = pair!.split("=");
    out[k!] = v.join("=");
  }
  return out;
}

const location = (res: Response) => new URL(res.headers.get("location")!, ORIGIN);

async function ask(email: string, next = "/") {
  return start.POST(post("/api/auth/email/start", { email, next }));
}

async function spend(token: string, headers: Record<string, string> = {}) {
  return verify.POST(post("/api/auth/email/verify", { token }, headers));
}

beforeEach(() => {
  globalThis.__formicMemoryStore = undefined;
  clearBuckets();
  inbox = new Inbox();
  setMailer(inbox);
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "");
  vi.stubEnv("FORMIC_MAILER", "console");
  vi.stubEnv("FORMIC_SECRET", "s".repeat(32));
  vi.stubEnv("FORMIC_ALLOWED_USERS", "");
});

afterEach(() => {
  setMailer(null);
  vi.unstubAllEnvs();
});

describe("email sign-in", () => {
  it("sends a link, and spending it signs a new person in with no GitHub", async () => {
    const asked = await ask("Ana@Example.com", "/settings");
    expect(location(asked).searchParams.get("sent")).toBe("1");
    expect(inbox.sent).toHaveLength(1);
    expect(inbox.sent[0]!.link).toMatch(/^http:\/\/localhost:3000\/login\/verify\?token=/);

    const res = await spend(inbox.tokenFor("ana@example.com"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings");
    const userId = await verifySession(cookiesOf(res)[SESSION_COOKIE]);
    const user = await repository().userById(userId!);
    expect(user).toMatchObject({ email: "ana@example.com", githubId: null, login: "ana" });
  });

  it("signs the same person in again on a second link, without a second account", async () => {
    await ask("ana@example.com");
    const first = await verifySession(cookiesOf(await spend(inbox.tokenFor("ana@example.com")))[SESSION_COOKIE]);
    await ask("ana@example.com");
    const second = await verifySession(cookiesOf(await spend(inbox.tokenFor("ana@example.com")))[SESSION_COOKIE]);
    expect(second).toBe(first);
    expect(await repository().countUsers()).toBe(1);
  });

  it("works once", async () => {
    await ask("ana@example.com");
    const token = inbox.tokenFor("ana@example.com");
    await spend(token);
    const again = await spend(token);
    expect(location(again).searchParams.get("error")).toContain("expired or was already used");
    expect(cookiesOf(again)[SESSION_COOKIE]).toBeUndefined();
  });

  it("stores only a hash of the link", async () => {
    await ask("ana@example.com");
    const token = inbox.tokenFor("ana@example.com");
    const stored = [...globalThis.__formicMemoryStore!.loginTokens.keys()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain(token);
    expect(stored[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a made-up link", async () => {
    const res = await spend("x".repeat(43));
    expect(location(res).searchParams.get("error")).toContain("expired");
  });

  it("answers the same for any address, so it can't be used to find accounts", async () => {
    await repository().createEmailUser({ email: "known@example.com", login: "known" });
    const known = await ask("known@example.com");
    const unknown = await ask("nobody@example.com");
    expect(location(known).search).toBe(location(unknown).search);
  });

  it("keeps where the person was going, but only on this site", async () => {
    await ask("ana@example.com", "//evil.example/x");
    const res = await spend(inbox.tokenFor("ana@example.com"));
    expect(res.headers.get("location")).toBe("/");
  });

  it("says when the address isn't one", async () => {
    const res = await ask("not-an-email");
    expect(location(res).searchParams.get("error")).toContain("doesn't look like an email");
    expect(inbox.sent).toHaveLength(0);
  });

  it("stops after three links to one address in fifteen minutes", async () => {
    for (let i = 0; i < 3; i++) await ask("ana@example.com");
    const fourth = await ask("ana@example.com");
    expect(location(fourth).searchParams.get("error")).toContain("Too many");
    expect(inbox.sent).toHaveLength(3);
  });

  it("stops after ten links from one IP in an hour", async () => {
    for (let i = 0; i < 10; i++) {
      clearBuckets();
      await ask(`p${i}@example.com`);
    }
    clearBuckets();
    const eleventh = await ask("p10@example.com");
    expect(location(eleventh).searchParams.get("error")).toContain("Too many");
  });

  it("refuses a sign-in form posted from another site", async () => {
    const asked = await start.POST(
      post("/api/auth/email/start", { email: "ana@example.com" }, { "sec-fetch-site": "cross-site" }),
    );
    expect(location(asked).searchParams.get("error")).toContain("own login page");
    expect(inbox.sent).toHaveLength(0);
  });

  it("refuses to spend a link posted from another site, and leaves it good", async () => {
    await ask("ana@example.com");
    const token = inbox.tokenFor("ana@example.com");
    const forged = await spend(token, { "sec-fetch-site": "cross-site" });
    expect(cookiesOf(forged)[SESSION_COOKIE]).toBeUndefined();
    expect(cookiesOf(await spend(token))[SESSION_COOKIE]).toBeDefined();
  });

  it("refuses an Origin from another site when the browser sends no Sec-Fetch-Site", async () => {
    const req = new Request(`${ORIGIN}/api/auth/email/start`, {
      method: "POST",
      body: form({ email: "ana@example.com" }),
      headers: { origin: "https://evil.example" },
    });
    await start.POST(req);
    expect(inbox.sent).toHaveLength(0);
  });

  it("sends nothing to an address off the allow-list, and says the same", async () => {
    vi.stubEnv("FORMIC_ALLOWED_USERS", "ana@example.com");
    const off = await ask("bo@example.com");
    expect(location(off).searchParams.get("sent")).toBe("1");
    expect(inbox.sent).toHaveLength(0);
    await ask("ana@example.com");
    expect(inbox.sent).toHaveLength(1);
  });

  it("will not sign in with a link whose address came off the allow-list since", async () => {
    await ask("ana@example.com");
    vi.stubEnv("FORMIC_ALLOWED_USERS", "someone-else@example.com");
    const res = await spend(inbox.tokenFor("ana@example.com"));
    expect(location(res).searchParams.get("error")).toContain("not on this Formic's list");
    expect(cookiesOf(res)[SESSION_COOKIE]).toBeUndefined();
  });

  it("refuses without a real FORMIC_SECRET", async () => {
    vi.stubEnv("FORMIC_SECRET", "");
    const res = await ask("ana@example.com");
    expect(location(res).searchParams.get("error")).toContain("FORMIC_SECRET");
    expect(inbox.sent).toHaveLength(0);
  });

  it("gives the first person to sign in the boards made before accounts", async () => {
    const demo = await repository().defaultProject();
    await ask("ana@example.com");
    const userId = await verifySession(cookiesOf(await spend(inbox.tokenFor("ana@example.com")))[SESSION_COOKIE]);
    expect((await repository().projectById(demo.id))?.ownerId).toBe(userId);
  });

  it("gives a later person nothing of anyone else's", async () => {
    await ask("ana@example.com");
    await spend(inbox.tokenFor("ana@example.com"));
    const loose = await repository().defaultProject();
    await ask("bo@example.com");
    const bo = await verifySession(cookiesOf(await spend(inbox.tokenFor("bo@example.com")))[SESSION_COOKIE]);
    expect((await repository().projectById(loose.id))?.ownerId).not.toBe(bo);
  });

  it("says so when the mail service refuses", async () => {
    setMailer({ name: "resend", sendSignIn: async () => { throw new Error("down"); } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await ask("ana@example.com");
    expect(location(res).searchParams.get("error")).toContain("couldn't be sent");
  });
});

describe("handles", () => {
  it("makes a display handle from the address", async () => {
    const { handleFor } = await import("@/lib/auth/email");
    expect(handleFor("Ana.Lopez+formic@example.com")).toBe("ana-lopez");
    expect(handleFor("___@example.com")).toBe("member");
  });
});
