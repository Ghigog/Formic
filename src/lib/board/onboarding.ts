import "server-only";

import { repository } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { positionForIndex } from "@/lib/ordering";
import { questionReason } from "@/lib/domain/question";
import { DESIGN_TICKET_TITLE, ONBOARDING_TICKET_TITLE } from "./onboarding-ticket";

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
  title: ONBOARDING_TICKET_TITLE,
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

/** Puts the onboarding ticket in a board's To Do column, ready to run; once only. */
export async function addOnboardingTicket(projectId: string): Promise<void> {
  const repo = repository();
  if ((await repo.boardCards(projectId)).some((c) => c.title === ONBOARDING_TICKET.title)) return;
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

/**
 * The second ticket on a new board: a design philosophy for the product,
 * from the person's own words. Without one, every agent designs from nothing
 * and features come out generic (see docs/plans/craft-and-direction.md). It
 * starts as a question to the person: their answer in its chat starts the
 * Coder Agent, which writes DESIGN.md from it and from what the repository
 * already shows. Every agent's prompt sends it to that file (DESIGN_RULE).
 */
export const DESIGN_TICKET = {
  title: DESIGN_TICKET_TITLE,
  description: [
    "Write DESIGN.md at the repository root: the product's design philosophy, which every agent follows when it builds anything a person sees.",
    "",
    "Start from the person's own description of the look and feel they want (in this ticket's notes), then read what the repository already shows: its styles, tokens, components and screens. Where the two disagree, the person's words win; say so in the file, so the next change can bring the code in line.",
    "",
    "Make it opinionated and specific: two agents reading it should build the same screen the same way. Sections: the feeling (three to five principles, each with what it means in practice), voice and tone, colour tokens, type, spacing and radii, motion and sound, components and their states (loading, empty, error, disabled), and do and don't, with examples. Point at files rather than pasting them in.",
  ].join("\n"),
  acceptanceCriteria: [
    "DESIGN.md at the repository root states three to five design principles, each with a concrete example from this product.",
    "DESIGN.md names the colour, type, spacing and motion tokens to use, pointing at the files that define them, or proposes them where the repository has none.",
    "Everything the person asked for in their description appears in DESIGN.md.",
  ],
  fileScope: ["DESIGN.md"],
  question: {
    question:
      "How should this product look and feel? Describe it in your own words: the mood, products you admire, colours, type, how things should move and sound. Rough is fine; the agents will shape it.",
    why: "Every screen the agents build will follow it, so features look like they belong.",
  },
};

/** Puts the design ticket in a board's To Do column, waiting on the person's description; once only. */
export async function addDesignTicket(projectId: string): Promise<void> {
  const repo = repository();
  if ((await repo.boardCards(projectId)).some((c) => c.title === DESIGN_TICKET.title)) return;
  const { title, description, acceptanceCriteria, fileScope, question } = DESIGN_TICKET;

  const epic = await repo.createEpic({ projectId, title, rawRequest: title, position: 0 });
  await repo.setStandalone(epic.id, true);

  const positions = await repo.columnPositions(projectId, "todo");
  const position = positionForIndex(positions, positions.length);
  const ticket = (
    await repo.createTickets([
      { epicId: epic.id, key: "T-1", title, description, acceptanceCriteria, fileScope, storyPoints: 3, position, dependsOnKeys: [] },
    ])
  )[0]!;
  const reason = questionReason("The Designer", [question]);
  await repo.move({ cardId: ticket.id, kind: "ticket", status: "blocked", stalledIn: "todo", position, detached: true });
  await repo.updateTicket(ticket.id, { blockedReason: reason });

  await publish(projectId, { type: "card.created", cardId: ticket.id, kind: "ticket", epicId: epic.id });
}
