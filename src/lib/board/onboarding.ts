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
  title: "Write the AGENTS.md every agent on this board starts from",
  description: [
    "**User story:** As the owner of this board, I'd like an AGENTS.md at the repository root, so that every agent starts each ticket already knowing how this codebase is built and tested.",
    "",
    "### Context",
    "Each ticket's agent starts cold. Without a map it spends dozens of tool calls rediscovering the same things: where each layer lives, how to run the checks, how the tests are written. AGENTS.md is the file Codex, Gemini CLI and Claude Code (through CLAUDE.md) all read before they start.",
    "",
    "### Description",
    "Read the repository and write a concise AGENTS.md for an agent about to change it. Only what is true here and not obvious from a file listing; nothing generic about good engineering.",
    "",
    "### Requirements",
    "- **Commands:** how to install, run, lint, typecheck and test, exactly as a contributor runs them, including how to run a single test file.",
    "- **Layers:** a map of how a change travels through the code (for example domain, data access, services, API routes, client state, components), naming the directory for each and one representative file.",
    "- **Test conventions:** where tests live, how they are named, which runner and environment each kind uses, the shared helpers and fixtures, and what is faked versus real.",
    "- **Hard-to-test behaviour:** how the tests handle the awkward parts (drag and drop, time, network, streaming, auth), with the helper to reuse.",
    "- **Traps:** anything that would cost the next agent many tool calls to rediscover: generated files not to edit by hand, required environment variables, ordering constraints, surprising conventions.",
    "- If a CLAUDE.md, AGENTS.md or GEMINI.md already exists, keep what is still true and fold it into AGENTS.md.",
    "- CLAUDE.md contains only the line `@AGENTS.md`, so Claude Code reads the same file.",
    "- Keep AGENTS.md under about 200 lines. Point to files rather than copying them.",
  ].join("\n"),
  acceptanceCriteria: [
    "Given the repository root, when an agent starts a ticket, then AGENTS.md tells it how to install, run, lint and test the project.",
    "Given AGENTS.md, when an agent needs to add a feature end to end, then it names the directory and a representative file for each layer.",
    "Given AGENTS.md, when an agent writes a test, then it describes where tests live, the helpers to reuse and how awkward behaviour is faked.",
    "Given CLAUDE.md, when Claude Code starts, then it imports AGENTS.md and holds nothing else.",
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
        size: "S",
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
