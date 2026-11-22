import "server-only";

import { repository } from "@/lib/db";
import type { AssistantMessage, AssistantProposal } from "@/lib/db/repository";
import { publish } from "@/lib/events/bus";

/**
 * Formic writes to the board chat unasked: a notice (a timeline line, never
 * the PM's own words), and an event so an open board can raise its unread
 * badge. Every message Formic itself authors goes through here.
 */
export async function postPmMessage(
  projectId: string,
  message: {
    content: string;
    cards?: AssistantMessage["cards"];
    proposals?: AssistantProposal[];
    /** A line in a playtest: the time it has left, newer work to play. */
    playtestId?: string;
  },
): Promise<AssistantMessage> {
  const posted = await repository().addAssistantMessage({
    projectId,
    role: "assistant",
    content: message.content,
    cards: message.cards,
    proposals: message.proposals,
    playtestId: message.playtestId,
    status: "done",
    speaker: "assistant",
    kind: "notice",
  });
  await publish(projectId, { type: "assistant.message", messageId: posted.id });
  return posted;
}
