import "server-only";

import { hasDatabase } from "./client";
import { MemoryRepository, seedMemory } from "./memory-repository";
import { PrismaRepository } from "./prisma-repository";
import type { Repository } from "./repository";
import { FIXTURE_CARDS } from "@/lib/fixtures/board";

let cached: Repository | null = null;

export function repository(): Repository {
  if (cached) return cached;

  if (hasDatabase()) {
    cached = new PrismaRepository();
  } else {
    // No database configured: run on the in-memory store, pre-loaded with the
    // demo board so a fresh clone shows something real.
    seedMemory(FIXTURE_CARDS);
    cached = new MemoryRepository();
  }
  return cached;
}

export { hasDatabase } from "./client";
export type { Repository } from "./repository";
