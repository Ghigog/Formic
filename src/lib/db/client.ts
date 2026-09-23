import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolConfig } from "pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Prisma 7 requires a driver adapter. The connection string never leaves the
 * server: this module is import-guarded by `server-only` through the callers
 * in src/lib/db/repository.ts.
 */

declare global {
  var __formicPrisma: PrismaClient | undefined;
}

// A value pasted verbatim from .env.example's KEY="value" syntax carries the
// quotes into a UI field that doesn't need them. Stripping one matching pair
// tolerates that; a URL never legitimately starts and ends with the same
// quote character.
function unquote(value: string): string {
  return value.match(/^(['"])([\s\S]*)\1$/)?.[2] ?? value;
}

export function databaseUrl(): string | null {
  // Vercel's Supabase integration doesn't name its variable DATABASE_URL, so
  // fall back to the pooled connection strings it does set. Prefer the one
  // built for Prisma (pgbouncer-aware) over the generic pooled URL.
  const url =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL;
  return url && url.length > 0 ? unquote(url.trim()) : null;
}

export function hasDatabase(): boolean {
  return databaseUrl() !== null;
}

/**
 * `db push`'s Rust migration engine and the `pg` driver used at runtime
 * disagree on what `sslmode=require` means: the engine treats it as
 * "encrypt, don't verify the chain" (libpq's actual semantics), while
 * node-postgres's URL parser now aliases it to `verify-full`. Against
 * Supabase, whose chain isn't in Node's default CA bundle, that made schema
 * pushes succeed and every runtime query fail with a TLS error. Only relax
 * verification for URLs that asked for SSL in the first place, so a local,
 * SSL-less Postgres (via `npm run db:local`) is unaffected.
 *
 * The `sslmode` has to come out of the string itself, not just be
 * countermanded with an explicit `ssl` option: pg's ConnectionParameters
 * re-parses `connectionString` and does
 * `Object.assign({}, config, parse(connectionString))`, so whatever the
 * string's own `sslmode` resolves to always overwrites an `ssl` passed
 * alongside it.
 */
function poolConfig(url: string): PoolConfig {
  if (!/[?&]sslmode=/.test(url)) return { connectionString: url };

  const stripped = new URL(url);
  stripped.searchParams.delete("sslmode");
  return { connectionString: stripped.toString(), ssl: { rejectUnauthorized: false } };
}

export function prisma(): PrismaClient {
  if (globalThis.__formicPrisma) return globalThis.__formicPrisma;

  const url = databaseUrl();
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Either configure a database or run with the in-memory store (see src/lib/db/repository.ts).",
    );
  }

  // Cached in every environment: callers invoke prisma() per query, so an
  // uncached production build opened a fresh pool per call and leaked them
  // until the database refused connections. globalThis (not module scope)
  // also survives dev-mode module reloads.
  globalThis.__formicPrisma = new PrismaClient({
    adapter: new PrismaPg(poolConfig(url)),
  });
  return globalThis.__formicPrisma;
}
