import { prisma } from "../src/lib/db/client";
import { seedDemoBoard } from "../src/lib/db/seed";

/**
 * `npm run db:seed`. See src/lib/db/seed.ts for the fixture itself; this is
 * just the CLI entry point, sharing the same connection resolution (and its
 * DATABASE_URL / POSTGRES_PRISMA_URL / POSTGRES_URL fallback) as the app.
 */
seedDemoBoard(prisma())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma().$disconnect());
