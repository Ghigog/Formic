import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { createPmToken, revokePmTokens } from "@/lib/access-tokens";
import { assistantAgentFor, markKeyLimited, type CliAgent } from "@/lib/agents/presets";
import { diagnose, formatReset } from "@/lib/agents/limits";
import { workedOn } from "@/lib/agents/limit-lift";
import { signingSecret } from "@/lib/auth/session";
import { credentialsForProject } from "@/lib/auth/credentials";
import { projectFor } from "@/lib/board/project";
import { repository } from "@/lib/db";
import type { AssistantMessage, PmSessionWhere } from "@/lib/db/repository";
import { publish } from "@/lib/events/bus";
import { postPmMessage } from "@/lib/assistant/pm-messages";
import { guestLabel, isGuestId } from "@/lib/assistant/guest-ids";
import { attachmentsPrompt, cancelJob, dispatchPmTurn, formicOrigin, runnerTakesSession } from "@/lib/runner/runner";
import { claudeContext, claudeUsage, type StreamItem } from "@/lib/runner/stream";
import { ASSISTANT_CHANGE_SUFFIX, jobId } from "@/lib/runner/workflow";
import { STAGING_PREFIX } from "@/lib/vcs/types";
import { open, seal } from "@/lib/secrets/vault";
import { vcs } from "@/lib/vcs";
import { landPmChange } from "./land";
import { killE2bTurn, killPmSandbox, runE2bTurn, SandboxUnavailable } from "./e2b-turn";
import { liveE2bTurns } from "./sandbox";
import { ciWhere, endPmSession as endStoredSession, openFile, sealFile, type PackedFile } from "./store";
import { before, newSince, runningSummary, turnMessage } from "./transcript";

export { setPmSandboxes } from "./sandbox";
export { recoverLostSandboxTurn } from "./recover";

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
 * What one PM turn may spend, on the agent's own model. A wake-up (a turn
 * nobody typed) is short; a person's message gets more room. Without these
 * a turn ran up to the job's hour, with no step limit.
 */
export const PM_TURN_LIMITS = {
  wake: { minutes: 10, maxTurns: 30 },
  person: { minutes: 20, maxTurns: 80 },
} as const;

/** The limits for a turn: a wake-up's, or a person's. */
export function turnLimits(wake: boolean, agentModel: string | null): { minutes: number; maxTurns: number; model: string | null } {
  const limits = wake ? PM_TURN_LIMITS.wake : PM_TURN_LIMITS.person;
  return { minutes: limits.minutes, maxTurns: limits.maxTurns, model: agentModel };
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
  const origin = formicOrigin();
  if (!origin) return false;

  const repo = repository();
  const project = await projectFor(projectId);
  // The PM acts as the board's owner, on this board only.
  if (!project.ownerId || !project.repoFullName) return false;
  const creds = await credentialsForProject(project);
  const sandbox = creds.repoToken ? e2bFor(agent, creds) : null;
  if (!sandbox && !(await sessionReady(projectId))) return false;

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
  const limits = turnLimits(!!input.wake, agent.model);
  const token = await createPmToken(project.ownerId, { projectId, sessionId, wake: !!input.wake });
  const handoff: Handoff = { token: token.secret, url: `${origin}/api/mcp` };

  // Fast: the session's own sandbox, kept warm between turns.
  if (sandbox && creds.repoToken) {
    // Live from here, so the idle sweep never takes it for one a restart lost.
    liveE2bTurns().add(job);
    await repo.savePmSession(projectId, {
      sessionId,
      where: "e2b",
      turnJob: job,
      handoff: null,
      resumed,
      branch: null,
      ...(resumed ? {} : { fileCipher: null, bytes: 0, contextTokens: 0 }),
    });
    await repo.updateAssistantMessage(messageId, { runnerJob: job, runnerAgent: agent.presetId });
    const toCi = async (why: string) => {
      // Ladder step 3: no sandbox to be had, so the repository's CI runs it.
      console.warn(`[formic] PM sandbox unavailable, using CI: ${why}`);
      await repo.updatePmSession(projectId, { sandboxId: null });
      if (!(await sessionReady(projectId))) {
        await revokePmTokens(projectId, sessionId);
        await repo.updatePmSession(projectId, { turnJob: null });
        await input.fail(`The PM's sandbox could not start: ${why}`);
        return;
      }
      await dispatchToCi({ projectId, messageId, agent, job, prompt, sessionId, resumed, handoff, limits, ciWhere: ciWhere(project.repoFullName), fail: input.fail });
    };
    void runInSandbox({
      projectId,
      messageId,
      job,
      prompt,
      sessionId,
      file: saved,
      sandboxId: existing?.sandboxId ?? null,
      e2bKey: sandbox.e2bKey,
      claudeToken: sandbox.claudeToken,
      model: limits.model,
      maxTurns: limits.maxTurns,
      timeoutMs: limits.minutes * 60_000,
      mcp: handoff,
      repoFullName: project.repoFullName,
      repoToken: creds.repoToken,
      baseBranch: project.baseBranch,
      toCi,
    }).catch((e: unknown) => console.error("[formic] PM sandbox turn failed:", e));
    return true;
  }

  await dispatchToCi({ projectId, messageId, agent, job, prompt, sessionId, resumed, handoff, limits, ciWhere: ciWhere(project.repoFullName), fail: input.fail });
  return true;
}

/**
 * The E2B key and Claude Code token that let the PM run in its own sandbox:
 * the board owner's own E2B key (never the operator's shared one, whose
 * minutes a warm session would spend) and the token kept on the PM agent.
 */
export function e2bFor(
  agent: CliAgent,
  creds: { e2bKey: string | null; e2bFallbackUserId: string | null },
): { e2bKey: string; claudeToken: string } | null {
  if (agent.info.cli !== "claude" || !agent.sessionToken) return null;
  if (!creds.e2bKey || creds.e2bFallbackUserId !== null) return null;
  return { e2bKey: creds.e2bKey, claudeToken: agent.sessionToken };
}

/** The turn as a job in the repository's CI, which collects its handoff once. */
async function dispatchToCi(input: {
  projectId: string;
  messageId: string;
  agent: CliAgent;
  job: string;
  prompt: string;
  sessionId: string;
  resumed: boolean;
  handoff: Handoff;
  limits: { minutes: number; model: string | null };
  ciWhere: PmSessionWhere;
  fail: (content: string) => Promise<void>;
}): Promise<void> {
  const { projectId, messageId, agent, job, sessionId, resumed } = input;
  const repo = repository();
  const url = sessionUrl(job);
  if (!url) {
    await revokePmTokens(projectId, sessionId);
    await input.fail("Formic's address is not set, so the PM's job could not reach it.");
    return;
  }
  await repo.savePmSession(projectId, {
    sessionId,
    where: input.ciWhere,
    turnJob: job,
    handoff: seal(JSON.stringify(input.handoff)),
    resumed,
    branch: null,
    ...(resumed ? {} : { fileCipher: null, bytes: 0 }),
  });

  // CI bounds the turn by its job's timeout; its steps are bounded in the sandbox only,
  // since a step limit there would need a change to every repository's workflow.
  const started = await dispatchPmTurn({
    projectId,
    messageId,
    agent: { ...agent, model: input.limits.model },
    job,
    prompt: input.prompt,
    session: url,
    minutes: input.limits.minutes,
  });
  if (!started.ok) {
    await revokePmTokens(projectId, sessionId);
    await repo.updatePmSession(projectId, { turnJob: null, handoff: null });
    await input.fail(started.reason);
  }
}

/** A turn in the session's sandbox, start to finish: its words streamed, its file kept, its reply posted. */
async function runInSandbox(input: Omit<Parameters<typeof runE2bTurn>[0], "onItems"> & { toCi: (why: string) => Promise<void> }): Promise<void> {
  const { projectId, messageId, job } = input;
  const repo = repository();
  liveE2bTurns().add(job);
  let result;
  try {
    result = await runE2bTurn({
      ...input,
      onItems: (items) => streamSessionReply(projectId, messageId, items),
      onLines: (lines) => recordSessionUsage(messageId, lines),
    });
  } catch (e) {
    if (e instanceof SandboxUnavailable) {
      await input.toCi(e.message);
      return;
    }
    throw e;
  } finally {
    liveE2bTurns().delete(job);
  }
  // Stopped meanwhile: the reply already says so, and the token is gone.
  if ((await repo.pmSession(projectId))?.turnJob !== job) {
    await repo.updatePmSession(projectId, { sandboxId: result.sandboxId });
    return;
  }
  await repo.updatePmSession(projectId, { sandboxId: result.sandboxId });
  await receiveSessionFile(job, { sessionId: result.sessionId, branch: result.branch, file: result.file });
  const { finishSessionAnswer } = await import("@/lib/assistant/turn");
  await finishSessionAnswer(projectId, messageId, job, {
    reply: result.reply,
    failure: result.failure,
    changeSha: result.changeSha,
  });
  if (result.changeSha) {
    const project = await projectFor(projectId);
    const creds = await credentialsForProject(project);
    await vcs(project.repoFullName, creds.repoToken)
      .deleteStagingBranch(`${STAGING_PREFIX}${job}${ASSISTANT_CHANGE_SUFFIX}`)
      .catch(() => undefined);
  }
}

/**
 * Ends the board's session: its tokens revoked, its sandbox killed, and its
 * row, file and summary gone. Clear calls this, so the next message starts
 * a fresh session.
 */
export async function endPmSession(projectId: string): Promise<void> {
  await killBoardSandbox(projectId);
  await endStoredSession(projectId);
}

/**
 * Kills the board's PM sandbox, if it has one, with the owner's E2B key. A
 * failure (no key, E2B down) is logged and swallowed: it must never block
 * Clear or a delete. A board that is deleted calls this first, since the
 * key is read from rows the delete removes.
 */
export async function killBoardSandbox(projectId: string): Promise<void> {
  try {
    const session = await repository().pmSession(projectId);
    if (!session?.sandboxId) return;
    const project = await projectFor(projectId);
    const creds = await credentialsForProject(project);
    if (creds.e2bKey) await killPmSandbox(session.sandboxId, creds.e2bKey);
  } catch (err) {
    console.warn(`[formic] could not kill the PM sandbox of board ${projectId}:`, err);
  }
}

/** Kills the PM sandbox of every board this person owns, before their account goes. Never rejects. */
export async function killOwnerSandboxes(ownerId: string): Promise<void> {
  try {
    const boards = await repository().listProjects({ ownerId, includeUnowned: false });
    await Promise.allSettled(boards.map((b) => killBoardSandbox(b.id)));
  } catch (err) {
    console.warn("[formic] could not list boards to kill their PM sandboxes:", err);
  }
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
  if (session.where === "e2b") {
    await killE2bTurn(job);
    return;
  }
  await cancelJob(projectId, job);
}

/**
 * What a turn used, from Claude Code's closing line in `lines`, added to its
 * reply and counted against the agent that ran it.
 */
export async function recordSessionUsage(messageId: string, lines: string[]): Promise<void> {
  const usage = claudeUsage(lines);
  const context = claudeContext(lines);
  if (!usage && context === null) return;
  const repo = repository();
  const message = await repo.assistantMessage(messageId);
  if (!message) return;
  if (usage && message.runnerAgent) await repo.addAssistantTokens(messageId, { presetId: message.runnerAgent, ...usage });
  if (context !== null) await repo.updatePmSession(message.projectId, { contextTokens: context });
}

/**
 * Past this much context a resumed session starts fresh from the summary:
 * turns are minutes apart, so the prompt cache has gone and every turn pays
 * to re-read the whole history.
 */
export const PM_CONTEXT_FRESH_AT = 150_000;

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
  // A PM that replied reached its model: whatever its failure text says, its
  // account is not out of usage.
  const limit = outcome.failure && !reply ? diagnose(outcome.failure, "The PM") : null;
  if (limit?.kind === "limit") {
    // Out of usage is not a broken session: keep it, retry nothing, and keep
    // the PM asleep until the window resets so wake-ups stop spending.
    const at = await markPmLimited(projectId, limit.until);
    await input.finish({ content: `The PM is out of Claude usage until ${formatReset(at)}, so it is resting until then. Nothing was retried.`, status: "failed" });
    return;
  }
  if (outcome.failure || !reply) {
    // A turn that ran out of time or steps did its spending: starting it again fresh would double it.
    const spent = !!outcome.failure && /timed out|timeout|max[ _-]?turns/i.test(outcome.failure);
    if (session.resumed && !spent) {
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
  await workedOn(projectId, await repo.assistantAgent(projectId));
  await keepSummary(projectId);
  // A session this long costs a whole history per message: the next one starts fresh from the summary.
  const after = await repo.pmSession(projectId);
  if (after && after.contextTokens > PM_CONTEXT_FRESH_AT && after.fileCipher) {
    await repo.updatePmSession(projectId, { fileCipher: null, bytes: 0, contextTokens: 0 });
    await postPmMessage(projectId, {
      content: "The PM's session got long, so its next message starts a fresh one from a summary of this chat. Each message costs much less that way.",
    });
  }
}

/** The PM's agent is out of usage until `until` (an hour when the CLI did not say). */
async function markPmLimited(projectId: string, until: Date | null): Promise<Date> {
  const at = until ?? new Date(Date.now() + 60 * 60 * 1000);
  const agent = await assistantAgentFor(projectId);
  if (agent.kind !== "cli" || !agent.agent.presetId) return at;
  const note = `The PM hit its usage limit. It can work again at ${formatReset(at)}.`;
  for (const presetId of await markKeyLimited(agent.agent.presetId, { until: at, note })) {
    await publish(projectId, { type: "agent.limited", presetId, until: at.toISOString(), note });
  }
  return at;
}

/** The running summary, after a turn. */
export async function keepSummary(projectId: string): Promise<void> {
  const repo = repository();
  const messages = (await repo.assistantMessages(projectId)).messages;
  await repo.updatePmSession(projectId, { summary: runningSummary(messages, name) });
}
