import "server-only";

import { revokePmTokens } from "@/lib/access-tokens";
import { repository } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { liveE2bTurns } from "./sandbox";

/**
 * A sandbox turn is run by the Formic process that started it. One that
 * restarted (a deploy) lost it: its reply says so, its token is revoked and
 * the session keeps the file it had, with the sandbox left for the next turn.
 * Called from the board's idle sweep.
 */
export async function recoverLostSandboxTurn(projectId: string): Promise<boolean> {
  const repo = repository();
  const session = await repo.pmSession(projectId);
  if (session?.where !== "e2b" || !session.turnJob || liveE2bTurns().has(session.turnJob)) return false;
  const job = session.turnJob;
  await revokePmTokens(projectId, session.sessionId);
  await repo.updatePmSession(projectId, { turnJob: null, handoff: null });
  const message = (await repo.assistantMessages(projectId)).messages.find((m) => m.runnerJob === job && m.status === "pending");
  if (message) {
    await repo.updateAssistantMessage(message.id, {
      content: "Formic restarted while the PM was answering, so this reply was lost. Ask again.",
      status: "failed",
      runnerJob: null,
    });
    await publish(projectId, { type: "assistant.failed", messageId: message.id });
  }
  return true;
}
