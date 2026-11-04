import "server-only";

/**
 * Sending the one email Formic sends: a sign-in link.
 *
 * Resend over its HTTP API when RESEND_API_KEY and FORMIC_EMAIL_FROM are set.
 * FORMIC_MAILER=console prints the link to the server log instead, for local
 * development and the e2e suite, which sign in without a real inbox.
 */

export interface SignInEmail {
  to: string;
  link: string;
  /** Minutes the link stays good for, said in the email. */
  minutes: number;
}

export interface Mailer {
  readonly name: "resend" | "console";
  sendSignIn(mail: SignInEmail): Promise<void>;
}

const RESEND = "https://api.resend.com/emails";

class ResendMailer implements Mailer {
  readonly name = "resend" as const;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async sendSignIn({ to, link, minutes }: SignInEmail): Promise<void> {
    const res = await fetch(RESEND, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to: [to],
        subject: "Your Formic sign-in link",
        text: signInText(link, minutes),
        html: signInHtml(link, minutes),
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Resend refused the sign-in email (${res.status}). ${detail.slice(0, 200)}`);
    }
  }
}

/**
 * Prints the link where whoever runs the server can see it. Every link
 * printed is only good once. FORMIC_MAILER_OUTBOX names a file each email is
 * also appended to as a line of JSON: how the e2e suite reads its inbox.
 */
class ConsoleMailer implements Mailer {
  readonly name = "console" as const;

  async sendSignIn(mail: SignInEmail): Promise<void> {
    console.info(`[formic] sign-in link for ${mail.to}: ${mail.link}`);
    const outbox = process.env.FORMIC_MAILER_OUTBOX;
    if (outbox) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(outbox, `${JSON.stringify(mail)}\n`);
    }
  }
}

let override: Mailer | null = null;
let consoleMailer: ConsoleMailer | null = null;

/** The mailer this deployment uses, or null when email sign-in is not set up. */
export function mailer(): Mailer | null {
  if (override) return override;
  if (process.env.FORMIC_MAILER === "console") return (consoleMailer ??= new ConsoleMailer());
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.FORMIC_EMAIL_FROM;
  return apiKey && from ? new ResendMailer(apiKey, from) : null;
}

/** Test seam: every email goes here. */
export function setMailer(m: Mailer | null): void {
  override = m;
}

export function signInText(link: string, minutes: number): string {
  return [
    "Sign in to Formic with this link:",
    "",
    link,
    "",
    `It works once and stops working in ${minutes} minutes.`,
    "If you didn't ask for it, ignore this email: nobody can sign in without it.",
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function signInHtml(link: string, minutes: number): string {
  const href = escapeHtml(link);
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#2b2420;line-height:1.5">
<p>Sign in to Formic:</p>
<p><a href="${href}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#b5562f;color:#fff;text-decoration:none;font-weight:600">Sign in to Formic</a></p>
<p style="color:#6b5e55;font-size:13px">It works once and stops working in ${minutes} minutes. If you didn't ask for it, ignore this email: nobody can sign in without it.</p>
<p style="color:#6b5e55;font-size:12px;word-break:break-all">${href}</p>
</body></html>`;
}
