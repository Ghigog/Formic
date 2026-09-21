import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

/**
 * Prisma 7 requires a driver adapter. The connection string never leaves the
 * server: this module is import-guarded by `server-only` through the callers
 * in src/lib/db/repository.ts.
 */

declare global {
  // eslint-disable-next-line no-var
  var __formicPrisma: PrismaClient | undefined;
}

export function databaseUrl(): string | null {
  const url = process.env.DATABASE_URL;
  return url && url.length > 0 ? url : null;
}

export function hasDatabase(): boolean {
  return databaseUrl() !== null;
}

export function prisma(): PrismaClient {
  if (globalThis.__formicPrisma) return globalThis.__formicPrisma;

  const url = databaseUrl();
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Either configure a database or run with the in-memory store (see src/lib/db/repository.ts).",
    );
  }

  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  // Next dev reloads modules; without this the pool grows on every edit.
  if (process.env.NODE_ENV !== "production") {
    globalThis.__formicPrisma = client;
  }
  return client;
}
