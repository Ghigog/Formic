import "node:process";
import path from "node:path";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 moved the connection URL out of schema.prisma. Migrate reads it
 * from here; the runtime client gets it through the pg driver adapter in
 * src/lib/db/client.ts.
 */
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Same fallback as src/lib/db/client.ts: Vercel's Supabase integration
    // doesn't set DATABASE_URL directly.
    url:
      process.env.DATABASE_URL ??
      process.env.POSTGRES_PRISMA_URL ??
      process.env.POSTGRES_URL ??
      "",
  },
});
