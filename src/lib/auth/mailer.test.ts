import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const smtp = vi.hoisted(() => ({
  options: [] as unknown[],
  sent: [] as Array<Record<string, unknown>>,
  closed: 0,
  fail: null as Error | null,
}));

vi.mock("nodemailer", () => ({
  createTransport: (options: unknown) => {
    smtp.options.push(options);
    return {
      sendMail: async (mail: Record<string, unknown>) => {
        if (smtp.fail) throw smtp.fail;
        smtp.sent.push(mail);
        return { messageId: "m1" };
      },
      close: () => {
        smtp.closed++;
      },
    };
  },
}));

const { mailer, setMailer } = await import("./mailer");
const { emailSignIn } = await import("./session");

const GMAIL = {
  SMTP_HOST: "smtp.gmail.com",
  SMTP_USER: "me@gmail.com",
  SMTP_PASSWORD: "abcd efgh ijkl mnop",
  FORMIC_EMAIL_FROM: "Formic <me@gmail.com>",
};

function stub(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

beforeEach(() => {
  setMailer(null);
  smtp.options = [];
  smtp.sent = [];
  smtp.closed = 0;
  smtp.fail = null;
  for (const k of ["FORMIC_MAILER", "RESEND_API_KEY", "FORMIC_EMAIL_FROM", "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_PORT"]) {
    vi.stubEnv(k, "");
  }
});

afterEach(() => vi.unstubAllEnvs());

describe("choosing a mailer", () => {
  it("has none, and no email sign-in, when nothing is set", () => {
    expect(mailer()).toBeNull();
    expect(emailSignIn()).toBe(false);
  });

  it("uses SMTP when its settings and a from address are set", () => {
    stub(GMAIL);
    expect(mailer()?.name).toBe("smtp");
    expect(emailSignIn()).toBe(true);
  });

  it("needs a from address", () => {
    stub({ ...GMAIL, FORMIC_EMAIL_FROM: "" });
    expect(mailer()).toBeNull();
    expect(emailSignIn()).toBe(false);
  });

  it("needs a password", () => {
    stub({ ...GMAIL, SMTP_PASSWORD: "" });
    expect(mailer()).toBeNull();
    expect(emailSignIn()).toBe(false);
  });

  it("uses Resend when only it is set", () => {
    stub({ RESEND_API_KEY: "re_x", FORMIC_EMAIL_FROM: "Formic <a@b.c>" });
    expect(mailer()?.name).toBe("resend");
    expect(emailSignIn()).toBe(true);
  });

  it("prefers SMTP when both are set", () => {
    stub({ ...GMAIL, RESEND_API_KEY: "re_x" });
    expect(mailer()?.name).toBe("smtp");
  });
});

describe("sending over SMTP", () => {
  const mail = { to: "ana@example.com", link: "https://52-200-209-60.sslip.io/login/verify?token=t", minutes: 15 };

  it("sends the link over TLS on 465, with the app password's spaces dropped", async () => {
    stub(GMAIL);
    await mailer()!.sendSignIn(mail);
    expect(smtp.options[0]).toMatchObject({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: "me@gmail.com", pass: "abcdefghijklmnop" },
    });
    expect(smtp.sent[0]).toMatchObject({ from: "Formic <me@gmail.com>", to: "ana@example.com", subject: "Your Formic sign-in link" });
    expect(String(smtp.sent[0]!.text)).toContain(mail.link);
    expect(String(smtp.sent[0]!.html)).toContain("https://52-200-209-60.sslip.io/login/verify?token=t");
    expect(smtp.closed).toBe(1);
  });

  it("requires STARTTLS on 587, so the password never goes in the clear", async () => {
    stub({ ...GMAIL, SMTP_PORT: "587" });
    await mailer()!.sendSignIn(mail);
    expect(smtp.options[0]).toMatchObject({ port: 587, secure: false, requireTLS: true });
  });

  it("passes on a refusal from the mail server, and still closes the connection", async () => {
    stub(GMAIL);
    smtp.fail = new Error("535 Username and Password not accepted");
    await expect(mailer()!.sendSignIn(mail)).rejects.toThrow("535");
    expect(smtp.closed).toBe(1);
  });
});
