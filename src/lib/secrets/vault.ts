import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encryption at rest for API keys saved on agent presets.
 *
 * AES-256-GCM with a key derived from FORMIC_SECRET. Without one it falls
 * back to the database URL, which still keeps keys out of a dump or backup
 * of the table itself, since those do not carry the environment. Set
 * FORMIC_SECRET to make the two independent. Changing it makes saved keys
 * unreadable, and presets fall back to the server's key until re-entered.
 */

function key(): Buffer {
  const material =
    process.env.FORMIC_SECRET ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL ||
    "formic-local-only";
  return createHash("sha256").update(`formic-vault:${material}`).digest();
}

/** `v1.<iv>.<tag>.<ciphertext>`, base64url. */
export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv, tag, data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** The plaintext, or null when it was sealed under a different secret. */
export function open(sealed: string): string | null {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/** What the editor shows for a saved key. */
export function hintFor(apiKey: string): string {
  return apiKey.slice(-4);
}
