import "server-only";

import { repository } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { positionForIndex } from "@/lib/ordering";

/**
 * The first ticket on a new board: an AGENTS.md for the repository. Every
 * later ticket's agent starts from it instead of spending its first fifty
 * tool calls rediscovering how the code is laid out and tested.
 *
 * AGENTS.md rather than CLAUDE.md, because a board runs Codex and Gemini as
 * well as Claude. Claude Code reads CLAUDE.md, so that becomes a one-line
 * import of AGENTS.md; the runner workflow points Gemini CLI at it; Codex
 * reads it as is.
 */
export const ONBOARDING_TICKET = {
  title: "Write an AGENTS.md so agents can find their way around this repo",
  description: [
    "Generate an AGENTS.md with the most useful things for agents working on this repo to know, including where to find various files and functions. Keep it short — point to files rather than pasting them in.",
    "",
    "Then reduce CLAUDE.md to the single line `@AGENTS.md`, so Claude Code reads the same file.",
  ].join("\n"),
  acceptanceCriteria: [
    "AGENTS.md at the repository root names the main directories and one representative file or function for each.",
    "CLAUDE.md contains only `@AGENTS.md`.",
  ],
  fileScope: ["AGENTS.md", "CLAUDE.md"],
};

/** Puts the onboarding ticket in a new board's To Do column, ready to run. */
export async function addOnboardingTicket(projectId: string): Promise<void> {
  const repo = repository();
  const { title, description, acceptanceCriteria, fileScope } = ONBOARDING_TICKET;

  const epic = await repo.createEpic({ projectId, title, rawRequest: title, position: 0 });
  await repo.setStandalone(epic.id, true);

  const positions = await repo.columnPositions(projectId, "todo");
  const position = positionForIndex(positions, positions.length);
  const ticket = (
    await repo.createTickets([
      {
        epicId: epic.id,
        key: "T-1",
        title,
        description,
        acceptanceCriteria,
        fileScope,
        storyPoints: 2,
        position,
        dependsOnKeys: [],
      },
    ])
  )[0]!;
  await repo.move({
    cardId: ticket.id,
    kind: "ticket",
    status: "ready",
    stalledIn: null,
    position,
    detached: true,
  });

  await publish(projectId, { type: "card.created", cardId: ticket.id, kind: "ticket", epicId: epic.id });
}
