import "server-only";

import { repository } from "@/lib/db";
import type { AssistantMessage, AssistantProposal } from "@/lib/db/repository";
import { publish } from "@/lib/events/bus";

/**
 * The PM writes to the board chat unasked: a done message from the
 * assistant, and an event so an open board can raise its unread badge.
 */
export async function postPmMessage(
  projectId: string,
  message: { content: string; cards?: AssistantMessage["cards"]; proposals?: AssistantProposal[] },
): Promise<AssistantMessage> {
  const posted = await repository().addAssistantMessage({
    projectId,
    role: "assistant",
    content: message.content,
    cards: message.cards,
    proposals: message.proposals,
    status: "done",
    speaker: "assistant",
  });
  await publish(projectId, { type: "assistant.message", messageId: posted.id });
  return posted;
}
