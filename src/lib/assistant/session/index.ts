import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { createPmToken, revokePmTokens } from "@/lib/access-tokens";
import type { CliAgent } from "@/lib/agents/presets";
import { signingSecret } from "@/lib/auth/session";
import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { repository } from "@/lib/db";
import type { AssistantMessage } from "@/lib/db/repository";
import { publish } from "@/lib/events/bus";
import { postPmMessage } from "@/lib/assistant/pm-messages";
import { guestLabel, isGuestId } from "@/lib/assistant/guest-ids";
import { attachmentsPrompt, cancelJob, dispatchPmTurn, formicOrigin, runnerTakesSession } from "@/lib/runner/runner";
import type { StreamItem } from "@/lib/runner/stream";
import { jobId } from "@/lib/runner/workflow";
import { open, seal } from "@/lib/secrets/vault";
import { vcs } from "@/lib/vcs";
import { landPmChange } from "./land";
import { ciWhere, openFile, sealFile, type PackedFile } from "./store";
import { before, newSince, runningSummary, turnMessage } from "./transcript";

export { endPmSession } from "./store";

/**
 * The board's PM as a resumable Claude Code session (docs/plans/pm-chat.md,
 * PR 3). Only a Claude Code PM runs here; an API-key PM keeps its loop in
 * ../turn.ts.
 *
 * A turn: the person's message (and whatever the board said since the last
 * turn) goes to the session, resumed from its saved file in the repository's
 * CI. The job collects the file and a board-scoped PM token from Formic
 * once, streams the session's words into the chat as it works, and hands
 * the file back when it ends. Formic then lands the PM's change under the
 * branch rules, puts the session's own reply in the chat, revokes the token
 * and keeps a running summary.
 *
 * The fallback ladder, from the bottom up here: a resumed turn that fails is
 * tried once more as a fresh session seeded from the summary, with a
 * "reconnected" notice. A reply is slower down the ladder, never lost.
 */

const name = (speaker: string) => (isGuestId(speaker) ? guestLabel(speaker) : speaker);

/** How long the job's address stays good: past the workflow's 60-minute cap, like an attachment link. */
const SESSION_URL_TTL_MS = 90 * 60 * 1000;

function sessionToken(job: string, expires: number): string {
  return createHmac("sha256", signingSecret()).update(`pm-session:${job}:${expires}`).digest("hex");
}

/** Where a turn's job collects the session and hands it back: good for that one job, for a while. */
export function sessionUrl(job: string, now = Date.now()): string | null {
  const origin = formicOrigin();
  if (!origin) return null;
  const expires = now + SESSION_URL_TTL_MS;
  const q = new URLSearchParams({ job, expires: String(expires), token: sessionToken(job, expires) });
  return `${origin}/api/runner/session?${q.toString()}`;
}

export function sessionAllowed(job: string, expires: string, token: string): boolean {
  if (!job || !/^\d+$/.test(expires) || Date.now() > Number(expires)) return false;
  const expected = Buffer.from(sessionToken(job, Number(expires)));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Whether the board's PM can run as a session now: its runner takes one, and the job can reach Formic. */
export async function sessionReady(projectId: string): Promise<boolean> {
  if (!formicOrigin()) return false;
  const project = await projectFor(projectId);
  if (!project.repoFullName) return false;
  const creds = await credentialsForProject(project);
  return runnerTakesSession(vcs(project.repoFullName, creds.repoToken), project.baseBranch).catch(() => false);
}

/** What a turn hands its job once: the board-scoped token for Formic's MCP server. */
interface Handoff {
  token: string;
  url: string;
}

/**
 * Starts the PM session's turn for the pending reply `messageId`. False
 * when the board cannot run one (its runner predates sessions, or nothing
 * can reach Formic): the PM then answers the old way. True when the turn
 * started, or failed to and the reply says why.
 */
export async function startSessionTurn(input: {
  projectId: string;
  messageId: string;
  agent: CliAgent;
  /** The session's brief, for a fresh session. */
  brief: string;
  /** Formic's own message, for a turn nobody typed. */
  wake?: string;
  /** Start a fresh session from the summary, whatever is saved. */
  fresh?: boolean;
  attempt?: number;
  fail: (content: string) => Promise<void>;
}): Promise<boolean> {
  const { projectId, messageId, agent } = input;
  if (agent.info.cli !== "claude") return false;
  if (!(await sessionReady(projectId))) return false;

  const repo = repository();
  const project = await projectFor(projectId);
  // The PM acts as the board's owner, on this board only.
  if (!project.ownerId) return false;
  const existing = await repo.pmSession(projectId);
  const saved = existing && !input.fresh ? openFile(existing) : null;
  const resumed = !!saved;
  const sessionId = resumed ? existing!.sessionId : randomUUID();

  const messages = (await repo.assistantMessages(projectId)).messages;
  const lines = newSince(messages, messageId);
  const earlier = before(messages, messageId).filter((m) => !lines.includes(m));
  const files = attachmentsPrompt(
    (lines as AssistantMessage[]).flatMap((m) => (m.role === "user" ? m.attachments.filter((a) => a.kind === "image") : [])),
  );
  const prompt = turnMessage({
    fresh: !resumed,
    brief: input.brief,
    summary: resumed ? "" : runningSummary(earlier, name),
    lines,
    guestName: name,
    wake: input.wake,
    files,
  });

  const job = jobId(messageId, randomUUID().slice(0, 8), input.attempt ?? 1);
  const url = sessionUrl(job);
  const origin = formicOrigin();
  if (!url || !origin) return false;

  const token = await createPmToken(project.ownerId, { projectId, sessionId });
  const handoff: Handoff = { token: token.secret, url: `${origin}/api/mcp` };
  await repo.savePmSession(projectId, {
    sessionId,
    where: ciWhere(project.repoFullName),
    turnJob: job,
    handoff: seal(JSON.stringify(handoff)),
    resumed,
    branch: null,
    ...(resumed ? {} : { fileCipher: null, bytes: 0 }),
  });

  const started = await dispatchPmTurn({ projectId, messageId, agent, job, prompt, session: url });
  if (!started.ok) {
    await revokePmTokens(projectId, sessionId);
    await repo.updatePmSession(projectId, { turnJob: null, handoff: null });
    await input.fail(started.reason);
  }
  return true;
}

/**
 * What the job collects when it starts: the session file (if there is one)
 * and its MCP token. Once only: a second ask, from anyone who saw the
 * address, gets nothing.
 */
export async function collectHandoff(
  job: string,
): Promise<{ sessionId: string; file: PackedFile; mcp: Handoff } | null> {
  const repo = repository();
  const session = await repo.pmSessionByJob(job);
  if (!session?.handoff) return null;
  await repo.updatePmSession(session.projectId, { handoff: null });
  const opened = open(session.handoff);
  if (!opened) return null;
  const mcp = JSON.parse(opened) as Handoff;
  return { sessionId: session.sessionId, file: session.resumed ? (openFile(session) ?? "") : "", mcp };
}

/**
 * The job hands the session back: its file, sealed and kept as the latest,
 * and the branch its checkout was on. A file over the cap is dropped, and
 * the chat is told the next turn starts from the summary.
 */
export async function receiveSessionFile(
  job: string,
  body: { sessionId: string; branch: string; file: PackedFile },
): Promise<boolean> {
  const repo = repository();
  const session = await repo.pmSessionByJob(job);
  if (!session) return false;
  const sealed = sealFile(body.file);
  await repo.updatePmSession(session.projectId, {
    sessionId: body.sessionId.trim() || session.sessionId,
    fileCipher: sealed?.cipher ?? null,
    bytes: sealed?.bytes ?? 0,
    branch: body.branch.trim() || null,
  });
  if (!sealed && body.file.trim()) {
    await postPmMessage(session.projectId, {
      content: "The PM's session grew past its size limit, so its next message starts a fresh session from a summary of this chat.",
    });
  }
  return true;
}

/**
 * The person stopped the reply a turn was writing: its job is cancelled and
 * its token revoked. The session keeps the file it had before the turn.
 */
export async function stopSessionTurn(projectId: string, job: string): Promise<void> {
  const repo = repository();
  const session = await repo.pmSessionByJob(job);
  if (!session || session.projectId !== projectId) return;
  await revokePmTokens(projectId, session.sessionId);
  await repo.updatePmSession(projectId, { turnJob: null, handoff: null });
  await cancelJob(projectId, job);
}

/** The most of a streamed reply kept while it is written; the latest part wins. */
const MAX_STREAMED = 12_000;

/**
 * The session's words, as they are written, in its pending reply: what it
 * says, and a line for each thing it does. The final reply replaces it.
 */
export async function streamSessionReply(projectId: string, messageId: string, items: StreamItem[]): Promise<void> {
  const parts: string[] = [];
  for (const item of items) {
    if (item.kind === "thought" && item.thought === "text") parts.push(item.text);
    else if (item.kind === "action") parts.push(`› ${item.label}`);
  }
  if (parts.length === 0) return;
  const repo = repository();
  const current = await repo.assistantMessage(messageId);
  if (!current || current.status !== "pending") return;
  const joined = [current.content, ...parts].filter((p) => p.trim()).join("\n\n");
  const content = joined.length > MAX_STREAMED ? `…${joined.slice(-MAX_STREAMED)}` : joined;
  await repo.updateAssistantMessage(messageId, { content });
  await publish(projectId, { type: "assistant.message", messageId });
}

export interface TurnOutcome {
  /** The session's own reply: its final words. */
  reply: string | null;
  failure: string | null;
  /** The head of the branch the job kept the PM's change on, if it changed anything. */
  changeSha: string | null;
}

/**
 * The job is over. Tokens revoked, the change landed, and the reply posted;
 * a resumed turn that failed is tried again as a fresh session.
 */
export async function finishSessionTurn(input: {
  projectId: string;
  messageId: string;
  job: string;
  outcome: TurnOutcome;
  finish: (update: { content: string; status: "done" | "failed" }) => Promise<void>;
  /** Starts the same reply again on a fresh session. False when it could not. */
  again: () => Promise<boolean>;
}): Promise<void> {
  const { projectId, messageId, job, outcome } = input;
  const repo = repository();
  const session = await repo.pmSessionByJob(job);
  if (!session) return;
  await revokePmTokens(projectId, session.sessionId);
  await repo.updatePmSession(projectId, { turnJob: null, handoff: null, lastTurnAt: new Date() });

  const reply = outcome.reply?.trim() ?? "";
  if (outcome.failure || !reply) {
    if (session.resumed) {
      // The saved session would not come back: carry on from the summary.
      await repo.updatePmSession(projectId, { fileCipher: null, bytes: 0 });
      await repo.updateAssistantMessage(messageId, { content: "" });
      await postPmMessage(projectId, {
        content: "Reconnected: the PM's session could not be picked back up, so it carries on in a fresh one from a summary of this chat.",
      });
      if (await input.again()) return;
    }
    await input.finish({ content: outcome.failure ?? "The PM finished without a reply.", status: "failed" });
    return;
  }

  if (outcome.changeSha) {
    const project = await projectFor(projectId);
    const creds = await credentialsForProject(project);
    await landPmChange({
      projectId,
      job,
      sha: outcome.changeSha,
      wanted: session.branch,
      client: vcs(project.repoFullName, creds.repoToken),
    }).catch((e: unknown) =>
      postPmMessage(projectId, { content: `Formic could not push the PM's change: ${e instanceof Error ? e.message : String(e)}` }),
    );
  }
  await input.finish({ content: reply, status: "done" });
  await keepSummary(projectId);
}

/** The running summary, after a turn. */
export async function keepSummary(projectId: string): Promise<void> {
  const repo = repository();
  const messages = (await repo.assistantMessages(projectId)).messages;
  await repo.updatePmSession(projectId, { summary: runningSummary(messages, name) });
}
