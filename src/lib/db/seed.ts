import type { PrismaClient } from "@/generated/prisma/client";

/**
 * Loads the demo board into a real database: one Epic with a PRD and four
 * child tickets across every column, plus a failed card and a card in review,
 * so each visual state has something behind it.
 *
 * Used both by `npm run db:seed` (prisma/seed.ts) and by instrumentation.ts,
 * which calls this once, lazily, the first time a configured database comes
 * up with no epics in it.
 */
export async function seedDemoBoard(prisma: PrismaClient): Promise<void> {
  const project = await prisma.project.upsert({
    where: { id: "project_seed" },
    update: {},
    create: {
      id: "project_seed",
      name: "Formic",
      repoFullName: process.env.GITHUB_REPO ?? "Ghigog/Formic",
      baseBranch: process.env.GITHUB_BASE_BRANCH ?? "main",
    },
  });

  await prisma.epic.deleteMany({ where: { projectId: project.id } });

  await prisma.epic.create({
    data: {
      projectId: project.id,
      title: "Let reviewers leave inline comments on a showcase",
      rawRequest:
        "Reviewers should be able to comment on specific steps of a showcase instead of replying in chat.",
      status: "draft",
      stage: 1,
      position: 1000,
    },
  });

  await prisma.epic.create({
    data: {
      projectId: project.id,
      title: "Saved board filters per project",
      rawRequest: "I want to save a filter and come back to it.",
      status: "specified",
      stage: 2,
      position: 2000,
      prd: {
        summary: "Persist per-project board filters and restore them on load.",
        problem: "Filters reset on every visit, so the same setup is rebuilt daily.",
        scope: ["Filter model and persistence", "Filter bar UI", "Restore on load"],
        outOfScope: ["Sharing filters between users"],
        technicalContext: ["Next.js App Router", "Prisma against Postgres"],
        userStories: ["As a user, my filter is still applied when I come back."],
        successCriteria: ["A saved filter survives a reload"],
      },
    },
  });

  const epic = await prisma.epic.create({
    data: {
      projectId: project.id,
      title: "Keyboard navigation across the board",
      rawRequest: "The board should be usable without a mouse.",
      status: "ready",
      stage: 3,
      position: 3000,
    },
  });

  const tickets = await Promise.all([
    prisma.ticket.create({
      data: {
        epicId: epic.id,
        key: "FOR-100",
        title: "Column scaffolding and layout grid",
        description: "The five-column grid and its responsive behaviour.",
        acceptanceCriteria: ["Renders at 375px with no horizontal scroll"],
        fileScope: ["src/components/board/column.tsx"],
        size: "M",
        status: "merged",
        stage: 8,
        position: 1000,
        prNumber: 38,
        prUrl: "https://github.com/example/formic/pull/38",
        costCents: 55,
      },
    }),
    prisma.ticket.create({
      data: {
        epicId: epic.id,
        key: "FOR-101",
        title: "Roving tabindex across columns",
        description: "Arrow keys move focus between cards and columns.",
        acceptanceCriteria: ["Focus is visible", "Tab order matches visual order"],
        fileScope: ["src/components/board"],
        size: "M",
        status: "ready",
        stage: 3,
        position: 2000,
      },
    }),
    prisma.ticket.create({
      data: {
        epicId: epic.id,
        key: "FOR-104",
        title: "Persist column order with a fractional index",
        description: "One row written per drag instead of renumbering a column.",
        acceptanceCriteria: ["A drag writes exactly one row"],
        fileScope: ["src/lib/ordering"],
        size: "M",
        status: "running",
        stage: 5,
        position: 3000,
        costCents: 88,
      },
    }),
    prisma.ticket.create({
      data: {
        epicId: epic.id,
        key: "FOR-105",
        title: "Drag handle hit area on touch devices",
        description: "Larger hit target for the drag affordance.",
        acceptanceCriteria: ["Handle is at least 44px on touch"],
        fileScope: ["src/components/board/card.tsx"],
        size: "S",
        status: "review",
        stage: 7,
        position: 4000,
        prNumber: 42,
        prUrl: "https://github.com/example/formic/pull/42",
        costCents: 31,
      },
    }),
    prisma.ticket.create({
      data: {
        epicId: epic.id,
        key: "FOR-103",
        title: "Announce card moves to screen readers",
        description: "Live region announcing drag results.",
        acceptanceCriteria: ["Moves are announced once, not twice"],
        fileScope: ["src/lib/a11y"],
        size: "S",
        status: "failed",
        stalledIn: "todo",
        stage: 5,
        position: 5000,
        blockedReason:
          "Coder agent edited outside its file scope (src/app/page.tsx)",
        attempts: 2,
        costCents: 42,
      },
    }),
  ]);

  // FOR-101 blocks FOR-103.
  const roving = tickets.find((t) => t.key === "FOR-101");
  const announce = tickets.find((t) => t.key === "FOR-103");
  if (roving && announce) {
    await prisma.ticketDependency.create({
      data: { ticketId: announce.id, dependsOnTicketId: roving.id },
    });
  }

  console.log(`Seeded project ${project.id}: 3 epics, ${tickets.length} tickets.`);
}
