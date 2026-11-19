import "server-only";

import { repository } from "@/lib/db";
import type { AssistantMessage, PlaytestRecord, ProjectSummary } from "@/lib/db/repository";
import { launch } from "@/lib/agents/pipeline";
import { answer } from "@/lib/assistant/turn";
import { postPmMessage } from "@/lib/assistant/pm-messages";
import { publish } from "@/lib/events/bus";
import { cloneUrl } from "@/lib/coder/checkout";
import { redact } from "@/lib/secrets/redact";
import { vcs } from "@/lib/vcs";
import { repoHost, repoPath } from "@/lib/vcs/host";
import { columnFor } from "@/lib/domain/status";
import { credentialsFor } from "@/lib/auth/credentials";
import { ownE2bKey } from "./access";
import { e2bRunner, type PlaytestRunner, type PlaytestStage } from "./runner";

/**
 * Playtest sessions: start, watch, stop. See docs/plans/playtest.md.
 *
 * A session's sandbox is started in the background (the server has no
 * function time limit), and the screen polls its state. The poll is also the
 * heartbeat, and the moment the time warning and the "newer work merged" line
 * are written. A reaper stops what nobody is watching.
 */

/** How long a playtest lasts. */
export const SESSION_MS = 20 * 60_000;
/** How long it has to come up. */
export const START_MS = 5 * 60_000;
/** When the PM says time is nearly up. */
export const WARN_MS = 5 * 60_000;
/** A screen that has not polled for this long was closed. */
export const STALE_MS = 90_000;
/** How often the default branch is checked for newer work. */
const HEAD_CHECK_MS = 30_000;
/** How often the heartbeat is written. */
const HEARTBEAT_WRITE_MS = 15_000;
/** How many lines of the start log are kept. */
const LOG_LINES = 30;

let runner: PlaytestRunner = e2bRunner;

/** Test seam: the sandbox a session runs in. */
export function setPlaytestRunner(next: PlaytestRunner | null): void {
  runner = next ?? e2bRunner;
}

/** What this process holds for a running session: the key to stop it with, and the start to abort. */
const live = new Map<string, { apiKey: string; abort: AbortController }>();
const headChecked = new Map<string, number>();

export interface PlaytestView {
  id: string;
  status: PlaytestRecord["status"];
  stage: string | null;
  kind: string | null;
  url: string | null;
  commitSha: string | null;
  error: string | null;
  logTail: string[];
  startedAt: string;
  endsAt: string;
  endedAt: string | null;
  endReason: string | null;
  summary: string | null;
  /** Newer work merged since this build: Restart picks it up. */
  newer: boolean;
}

export function viewOf(r: PlaytestRecord): PlaytestView {
  return {
    id: r.id,
    status: r.status,
    stage: r.stage,
    kind: r.kind,
    url: r.status === "live" ? r.url : null,
    commitSha: r.commitSha,
    error: r.error,
    logTail: r.logTail ? r.logTail.split("\n") : [],
    startedAt: r.startedAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
    endReason: r.endReason,
    summary: r.summary,
    newer: !!r.nudgedSha && r.nudgedSha !== r.commitSha,
  };
}

export function isOpen(r: PlaytestRecord): boolean {
  return r.status === "starting" || r.status === "live";
}

/** Starts a session for this person, ending any other they have open, on any board. */
export async function startPlaytest(input: {
  project: ProjectSummary;
  userId: string;
  e2bKey: string;
  repoToken: string;
  formicOrigin: string;
}): Promise<PlaytestRecord> {
  const repo = repository();
  for (const other of await repo.openPlaytestsFor(input.userId)) await stopPlaytest(other.id, "replaced");
  const record = await repo.createPlaytest({
    projectId: input.project.id,
    userId: input.userId,
    endsAt: new Date(Date.now() + SESSION_MS),
  });
  ensureReaper();
  launch(() => runSession(record.id, input), `playtest ${record.id}`);
  return record;
}

async function runSession(
  id: string,
  input: { project: ProjectSummary; e2bKey: string; repoToken: string; formicOrigin: string },
): Promise<void> {
  const repo = repository();
  const abort = new AbortController();
  live.set(id, { apiKey: input.e2bKey, abort });

  const log: string[] = [];
  let stage: PlaytestStage = "sandbox";
  let label: string | undefined;
  let dirty = false;
  const flush = async () => {
    if (!dirty) return;
    dirty = false;
    await repo
      .updatePlaytest(id, { stage: label ? `${stage}:${label}` : stage, logTail: log.join("\n") })
      .catch(() => undefined);
  };
  const timer = setInterval(() => void flush(), 1500);
  timer.unref?.();

  const { repoFullName, baseBranch } = input.project;
  const bareUrl =
    repoHost(repoFullName) === "gitlab"
      ? `https://gitlab.com/${repoPath(repoFullName)}.git`
      : `https://github.com/${repoFullName}.git`;

  try {
    const started = await runner.start({
      apiKey: input.e2bKey,
      cloneUrl: cloneUrl(repoFullName, input.repoToken),
      bareUrl,
      branch: baseBranch,
      lifetimeMs: SESSION_MS + 60_000,
      startMs: START_MS,
      formicOrigin: input.formicOrigin,
      signal: abort.signal,
      onStage: (s, l) => {
        stage = s;
        if (l) label = l;
        dirty = true;
      },
      onLog: (line) => {
        log.push(line.slice(0, 400));
        if (log.length > LOG_LINES) log.shift();
        dirty = true;
      },
      onSandbox: (sandboxId) => void repo.updatePlaytest(id, { sandboxId }).catch(() => undefined),
    });
    clearInterval(timer);
    await flush();
    const now = await repo.playtest(id);
    if (!now || !isOpen(now)) {
      // Stopped while it was starting: the stop could not reach a sandbox that had no id yet.
      if (now?.sandboxId) await runner.kill(now.sandboxId, input.e2bKey);
      return;
    }
    await repo.updatePlaytest(id, {
      status: "live",
      url: started.url,
      commitSha: started.commitSha,
      kind: started.kind,
      stage: null,
      // The clock starts once it can be played.
      endsAt: new Date(Date.now() + SESSION_MS),
      heartbeatAt: new Date(),
    });
  } catch (e) {
    clearInterval(timer);
    await flush();
    const message = redact(e instanceof Error ? e.message : String(e));
    const now = await repo.playtest(id);
    if (now?.sandboxId) await runner.kill(now.sandboxId, input.e2bKey);
    if (now && isOpen(now)) {
      await repo.updatePlaytest(id, { status: "failed", error: message, endedAt: new Date(), endReason: "failed" });
    }
    live.delete(id);
  }
}

/** Ends a session and its sandbox. Safe to call twice. */
export async function stopPlaytest(id: string, reason: "stopped" | "time" | "closed" | "replaced"): Promise<PlaytestRecord | null> {
  const repo = repository();
  const record = await repo.playtest(id);
  if (!record) return null;
  if (!isOpen(record)) return record;

  const held = live.get(id);
  live.delete(id);
  headChecked.delete(id);
  held?.abort.abort();
  await repo.updatePlaytest(id, { status: "ended", endedAt: new Date(), endReason: reason });

  const apiKey = held?.apiKey ?? ownE2bKey(await repo.userById(record.userId));
  if (record.sandboxId && apiKey) await runner.kill(record.sandboxId, apiKey);

  const messages = await repo.playtestMessages(id);
  const summary = summarize(messages);
  if (summary) {
    await repo.updatePlaytest(id, { summary });
    await postPmMessage(record.projectId, { content: `Playtest over. ${summary}`, playtestId: id }).catch(() => undefined);
  }
  return repository().playtest(id);
}

/**
 * What a session came to: "3 notes, 1 ticket proposed, 2 intended". The PM
 * starts each verdict with its bold word (see the playtest rule in its prompt).
 */
export function summarize(messages: AssistantMessage[]): string | null {
  const notes = messages.filter((m) => m.role === "user").length;
  if (!notes) return null;
  const replies = messages.filter((m) => m.role === "assistant" && m.status === "done");
  const count = (word: RegExp) => replies.reduce((n, m) => n + (m.content.match(word)?.length ?? 0), 0);
  const tickets = replies.reduce(
    (n, m) => n + m.proposals.filter((p) => (p.action as { type?: string } | null)?.type === "create_backlog_item").length,
    0,
  );
  const intended = count(/\*\*Intended\*\*/g);
  const known = count(/\*\*Already known\*\*/g);
  const parts = [
    `${notes} ${notes === 1 ? "note" : "notes"}`,
    ...(tickets ? [`${tickets} ${tickets === 1 ? "ticket" : "tickets"} proposed`] : []),
    ...(known ? [`${known} already known`] : []),
    ...(intended ? [`${intended} intended`] : []),
  ];
  return `${parts.join(", ")}.`;
}

/**
 * What a poll does besides reading: the heartbeat, the end of time, the
 * five-minute warning, and "T-42 just merged" when the default branch has
 * moved past the build being played.
 */
export async function tick(record: PlaytestRecord, project: ProjectSummary): Promise<PlaytestRecord> {
  const repo = repository();
  const now = Date.now();
  if (!isOpen(record)) return record;
  if (now >= record.endsAt.getTime()) return (await stopPlaytest(record.id, "time")) ?? record;

  if (now - record.heartbeatAt.getTime() > HEARTBEAT_WRITE_MS) {
    await repo.updatePlaytest(record.id, { heartbeatAt: new Date(now) });
  }
  if (record.status !== "live") return record;

  if (!record.warned && record.endsAt.getTime() - now <= WARN_MS) {
    await repo.updatePlaytest(record.id, { warned: true });
    await postPmMessage(project.id, { content: "5 minutes left in this playtest.", playtestId: record.id });
  }

  const last = headChecked.get(record.id) ?? 0;
  if (record.commitSha && now - last > HEAD_CHECK_MS) {
    headChecked.set(record.id, now);
    const user = await repo.userById(record.userId);
    const creds = await credentialsFor(user, repoHost(project.repoFullName)).catch(() => null);
    const head = creds?.repoToken
      ? await vcs(project.repoFullName, creds.repoToken).branchHead(project.baseBranch).catch(() => null)
      : null;
    if (head && head !== record.commitSha && head !== record.nudgedSha) {
      await repo.updatePlaytest(record.id, { nudgedSha: head });
      const since = record.startedAt.getTime();
      const merged = (await repo.boardCards(project.id))
        .filter((c) => c.kind === "ticket" && columnFor(c.status, c.stalledIn) === "done" && c.mergedAt && Date.parse(c.mergedAt) > since)
        .map((c) => c.key);
      const what = merged.length
        ? `${merged.slice(0, 4).join(", ")}${merged.length > 4 ? ` and ${merged.length - 4} more` : ""} just merged.`
        : "Newer work just landed on the default branch.";
      await postPmMessage(project.id, { content: `${what} Restart to play it.`, playtestId: record.id });
    }
  }
  return (await repo.playtest(record.id)) ?? record;
}

/**
 * Writes a note in a session, with the screenshots uploaded for it under
 * their own request ids (`playtest-…`), which it claims the way a PM chat
 * message claims its images. The PM is asked once the person pauses
 * (askAboutNotes).
 */
export async function addNote(record: PlaytestRecord, text: string, requestIds: string[]): Promise<AssistantMessage> {
  const repo = repository();
  const note = await repo.addAssistantMessage({
    projectId: record.projectId,
    role: "user",
    content: text.trim(),
    playtestId: record.id,
  });
  for (const requestId of new Set(requestIds)) {
    if (!requestId.startsWith("playtest-")) continue;
    // Only this board's own uploads: a request id from elsewhere claims nothing.
    const waiting = await repo.attachmentsFor({ requestId });
    const scopes = await Promise.all(waiting.map((a) => repo.attachmentScope(a.id)));
    if (!waiting.length || scopes.some((s) => s?.projectId !== record.projectId)) continue;
    await repo.claimAttachments(requestId, { assistantMessageId: note.id });
  }
  await publish(record.projectId, { type: "assistant.message", messageId: note.id });
  return { ...note, attachments: await repo.attachmentsFor({ assistantMessageId: note.id }) };
}

/**
 * Asks the PM about every note since it was last asked, in one reply. Does
 * nothing when there is none. The reply waits its turn behind any other the
 * PM is writing, the same queue the top bar uses.
 */
export async function askAboutNotes(record: PlaytestRecord): Promise<boolean> {
  const repo = repository();
  const notes = (await repo.playtestMessages(record.id)).filter(
    (m) => m.role === "user" && (!record.answeredAt || m.createdAt > record.answeredAt),
  );
  const newest = notes.at(-1);
  if (!newest) return false;
  await repo.updatePlaytest(record.id, { answeredAt: newest.createdAt });
  const busy = !!(await repo.pendingAssistantMessage(record.projectId));
  const reply = await repo.addAssistantMessage({
    projectId: record.projectId,
    role: "assistant",
    content: "",
    status: "pending",
    speaker: "assistant",
    playtestId: record.id,
  });
  if (!busy) launch(() => answer(record.projectId, reply.id), `playtest answer ${reply.id}`);
  return true;
}

/* ------------------------------------------------------------- reaper */

declare global {
  var __formicPlaytestReaper: ReturnType<typeof setInterval> | undefined;
}

/** Stops sessions nobody is watching, and ones past their time. One per process. */
export function ensureReaper(): void {
  if (globalThis.__formicPlaytestReaper) return;
  const timer = setInterval(() => void reap().catch(() => undefined), 30_000);
  timer.unref?.();
  globalThis.__formicPlaytestReaper = timer;
}

export async function reap(now = Date.now()): Promise<void> {
  for (const r of await repository().openPlaytests()) {
    if (now >= r.endsAt.getTime()) await stopPlaytest(r.id, "time");
    else if (now - r.heartbeatAt.getTime() > STALE_MS) await stopPlaytest(r.id, "closed");
  }
}
