import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encryption at rest for API keys saved on agent presets and settings.
 *
 * AES-256-GCM with a key derived from FORMIC_SECRET. The database URL is
 * never key material: whoever knows the address could read saved keys. With
 * no secret and no database (a laptop, the memory repository) nothing sealed
 * outlives the process, so a fixed local key is fine. With a database and no
 * secret, sealing refuses. Changing the secret makes saved keys unreadable,
 * and presets fall back to the server's key until re-entered.
 */

const MISSING = "Set FORMIC_SECRET before saving API keys: a database is configured, and saved keys need a secret of their own to be encrypted under.";

export class VaultKeyMissingError extends Error {
  constructor() {
    super(MISSING);
    this.name = "VaultKeyMissingError";
  }
}

function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_PRISMA_URL || process.env.POSTGRES_URL);
}

/** Why saved keys cannot be encrypted right now, or null when they can. */
export function vaultProblem(): string | null {
  return process.env.FORMIC_SECRET || !hasDatabase() ? null : MISSING;
}

function key(): Buffer | null {
  const material = process.env.FORMIC_SECRET || (hasDatabase() ? null : "formic-local-only");
  return material === null ? null : createHash("sha256").update(`formic-vault:${material}`).digest();
}

/** `v1.<iv>.<tag>.<ciphertext>`, base64url. */
export function seal(plaintext: string): string {
  const k = key();
  if (!k) throw new VaultKeyMissingError();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv, tag, data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** The plaintext, or null when it was sealed under a different secret. */
export function open(sealed: string): string | null {
  const [version, iv, tag, data] = sealed.split(".");
  const k = key();
  if (!k || version !== "v1" || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64url"));
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
