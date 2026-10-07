import "server-only";

/**
 * The coding loop, as a job can run it.
 *
 * `runCodingLoop` is TypeScript in this repository, and a GitHub Actions job in
 * someone else's repository does not have it. That is the whole of the problem
 * this file answers: one JSON payload in, one JSON report out, so an agent on
 * an API key can work for as long as a CLI agent instead of being stopped by
 * the serverless roof it normally runs under. See docs/long-runs.md.
 *
 * Three rules hold it together:
 *
 * - **It is an adapter, not a second loop.** The brief, the prompt and the
 *   tools belong to the Coder Agent (`coderPrompt`, `CODER_BRIEF`) and the loop
 *   belongs to `runCodingLoop`; nothing here reimplements either.
 * - **It touches no database, repository or event bus.** Progress goes to the
 *   sink the caller passed, the diff comes back in the report, and posting
 *   either of them to Formic is the workflow's job, not this one's.
 * - **It runs anywhere Node runs.** The loop's only Next-specific line,
 *   `import "server-only"`, is aliased to a no-op by the bundle (exactly as
 *   `vitest.config.ts` aliases it for the same reason), and this module's own
 *   import of it is there to keep a client import out in the app.
 *
 * The workspace is `scopedWorkspace(<local sandbox>, ticket.fileScope)`: the
 * loop runs in the job, its tools run in the job's checkout, and a write
 * outside the ticket's file scope is refused before it reaches a file. Scope
 * checks are provider-independent, so a job that must be locked down can hand
 * this module an E2B-backed workspace instead and nothing else changes.
 */

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

import { coderPrompt } from "@/lib/agents/coder";
import { runCodingLoop } from "@/lib/agents/coding-loop";
import type { AgentContext, CoderTask, Usage } from "@/lib/agents/ports";
import { budgetTokens } from "@/lib/agents/ports";
import { isSpikeText } from "@/lib/colony/game";
import { CODER_BRIEF, CHECKPOINT_RULE, withCodingRules } from "@/lib/agents/prompts";
import { billingFor, spendCeilingNote, turnCeiling } from "@/lib/budget/limits";
import type { PlanStep } from "@/lib/domain/entities";
import type { FormicEvent } from "@/lib/domain/events";
import { isProviderId, provider, type ProviderId } from "@/lib/llm/providers";
import { LocalSandboxProvider, localCheckout } from "@/lib/sandbox/local";
import { DEFAULT_TTL_MS, type SandboxHandle } from "@/lib/sandbox/types";
import { sandboxWorkspace, scopedWorkspace, type Workspace } from "@/lib/sandbox/workspace";

/**
 * What the job hands in. Everything the loop needs and nothing it can look up:
 * this module has no database, so the ticket, the repository and the key all
 * arrive here.
 *
 * It crosses a process boundary, so it is parsed rather than trusted.
 */
export const loopEntryPayloadSchema = z.object({
  /** The run this is, for the events. A job passes its own id. */
  runId: z.string().min(1).optional(),
  /** The ticket's id, for progress lines. Defaults to its key. */
  ticketId: z.string().min(1).optional(),
  /** Which board the run belongs to. Reported back, never looked up. */
  projectId: z.string().min(1).optional(),
  ticket: z.object({
    key: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    acceptanceCriteria: z.array(z.string()),
    fileScope: z.array(z.string()),
    /** What the person watching told this ticket's agents, oldest first. */
    notes: z.array(z.string()).optional(),
    /** What this run was asked to do from the ticket's chat, if anything. */
    instruction: z.string().optional(),
  }),
  repo: z.object({
    /** "owner/name". The clone URL is derived from it when none is given. */
    fullName: z.string().min(1),
    baseBranch: z.string().min(1),
    /**
     * An existing checkout to work in instead of cloning one: the job that
     * runs this has already checked the repository out, at the commit the run
     * starts from, and its work and its commit both belong there.
     */
    dir: z.string().min(1).optional(),
    /** A branch to cut for this run. Omitted works on the base branch. */
    branchName: z.string().min(1).optional(),
    /** An explicit clone URL, for a remote that is not github.com. */
    cloneUrl: z.string().min(1).optional(),
  }),
  provider: z.string().min(1),
  model: z.string().min(1),
  apiKey: z.string().min(1),
  /**
   * The ticket's budget, as a plan. Omitted means the run has no ceiling of
   * its own here — the loop's turn ceiling and the job's `timeout-minutes`
   * are what bound it. Money only applies to a provider billed per token.
   */
  limits: z
    .object({
      maxDurationMs: z.number().int().positive().optional(),
      /** The ticket's own budget, before the job's ceiling clamped it. */
      budgetMs: z.number().int().positive().optional(),
      /** Tokens the run may use, checked between turns. */
      maxTokens: z.number().int().positive().optional(),
      /** Derived from the tokens at a conservative rate; never shown as a budget. */
      maxCents: z.number().nonnegative().optional(),
    })
    .optional(),
});

export type LoopEntryPayload = z.infer<typeof loopEntryPayloadSchema>;

/**
 * Why a run stopped, when the entry itself stopped it. Null for every other
 * ending, whose reason is the loop's own words in `error` — a provider's
 * refusal, a quota, or the turn ceiling.
 */
export type LoopEntryLimit = "time" | "tokens" | "spend" | null;

/**
 * What the job gets back, as JSON on stdout. A change carries the loop's own
 * report; a failure carries only why, and the diff of whatever it managed to
 * do before it stopped.
 */
export type LoopEntryReport =
  | {
      ok: true;
      summary: string;
      detail: string;
      verifiedWith: string | null;
      alreadyDone: boolean;
      handoff: string[];
      limit: LoopEntryLimit;
      usage: Usage;
      changedFiles: string[];
      diff: string;
    }
  | {
      ok: false;
      error: string;
      blocked: boolean;
      limit: LoopEntryLimit;
      usage: Usage;
      changedFiles: string[];
      diff: string;
    };

export interface LoopEntryOptions {
  /**
   * Where the loop runs. Left out, a local sandbox clones the repository and
   * the loop works there; a test passes a checkout of its own.
   */
  workspace?: Workspace;
  /** Every event the loop publishes, for a caller that reports them on. */
  onEvent?: (event: FormicEvent) => void;
  /**
   * One human line per event, for a log someone reads by eye. Left out — as
   * in a job — the default is one JSON event per line on stderr, which is
   * what a job's reporter posts back to Formic.
   */
  log?: (line: string) => void;
}

/**
 * The brief this job's loop runs on: the Coder Agent's own, plus the
 * checkpoint rule it can act on here and an in-process run cannot. A job
 * saves the checkout and the progress file while the run works, and those
 * notes are what a resumed run reads: with the files and no notes, the next
 * run knows where the work got to but not why, and explores it all again.
 * The rule is the same one a CLI agent's prompt carries.
 */
function jobBrief(title: string): string {
  const brief = withCodingRules(CODER_BRIEF, "coder", { spike: isSpikeText(title) });
  return process.env.FORMIC_PROGRESS ? `${brief}\n\n${CHECKPOINT_RULE}` : brief;
}

/**
 * Runs the Coder Agent's loop once, in the workspace this hands it, and
 * reports what it did.
 *
 * The run's own ceilings are applied here, not by the loop: the loop keeps one
 * implementation for every path, and both of these are about *this* run's
 * container — a deadline it must stop before, and (for a metered provider) a
 * spend ceiling. A run that hits one stops between turns and says which.
 */
export async function runLoopEntry(
  payloadInput: unknown,
  options: LoopEntryOptions = {},
): Promise<LoopEntryReport> {
  const payload = loopEntryPayloadSchema.parse(payloadInput);
  const info = provider(payload.provider);
  if (!isProviderId(payload.provider) || !info) {
    throw new Error(`No such provider: ${payload.provider}.`);
  }
  if (info.kind === "cli") {
    throw new Error(
      `${info.label} is a CLI agent: it runs as an Actions job of its own, not through the loop entry.`,
    );
  }

  const { ticket } = payload;
  const ticketId = payload.ticketId ?? ticket.key;
  const runId = payload.runId ?? randomUUID();
  const maxDurationMs = payload.limits?.maxDurationMs;
  const maxCents = payload.limits?.maxCents;
  const maxTokens = payload.limits?.maxTokens;
  // Money only stops a run that is billed per token. A flat-rate plan and an
  // id nobody has priced are bounded by time, exactly as in-process.
  const billing = billingFor(payload.model, payload.provider);

  const controller = new AbortController();
  const limit: { hit: LoopEntryLimit } = { hit: null };

  const stop = (hit: Exclude<LoopEntryLimit, null>, reason: Error) => {
    if (limit.hit) return;
    limit.hit = hit;
    controller.abort(reason);
  };

  // The sandbox always outlives the budget: a long run on the default
  // 20-minute TTL would lose its checkout halfway through its own work.
  const ttlMs = Math.max(DEFAULT_TTL_MS, (maxDurationMs ?? 0) + 5 * 60 * 1000);
  const deadline = maxDurationMs
    ? setTimeout(() => stop("time", ranOutOfTime(maxDurationMs, payload.limits?.budgetMs)), maxDurationMs)
    : null;
  // A timer must not be the reason a job stays alive after its run is done.
  deadline?.unref?.();

  let spentCents = 0;
  let spentTokens = 0;
  let sandbox: SandboxHandle | null = null;

  /** Every event the loop publishes: out to the caller, then the log. */
  const emit = (event: FormicEvent): void => {
    options.onEvent?.(event);
    if (options.log) {
      const line = logLine(event);
      if (line) options.log(line);
      return;
    }
    // No sink given: one JSON event per line on stderr, which is what the
    // job's reporter reads back into the board (readStreamLine knows these),
    // and what the job's own log shows — the same shape a CLI agent's
    // stream-json arrives in.
    process.stderr.write(`${JSON.stringify(event)}\n`);
  };

  try {
    let raw = options.workspace;
    if (!raw) {
      const onLog = (stream: "stdout" | "stderr", line: string) =>
        emit({ type: "run.log", runId, ticketId, stream, line });
      // A job hands in its own checkout; anywhere else, one is cloned here.
      sandbox = payload.repo.dir
        ? await localCheckout(payload.repo.dir, { ttlMs, onLog })
        : await new LocalSandboxProvider().spawn({
            repoFullName: payload.repo.fullName,
            ...(payload.repo.cloneUrl ? { cloneUrl: payload.repo.cloneUrl } : {}),
            baseBranch: payload.repo.baseBranch,
            ...(payload.repo.branchName ? { branchName: payload.repo.branchName } : {}),
            ttlMs,
            signal: controller.signal,
            onLog,
          });
      raw = sandboxWorkspace(sandbox);
    }

    // The file scope is enforced here, whatever the provider: the checks are
    // about the ticket, not about where the checkout lives.
    const workspace = scopedWorkspace(raw, ticket.fileScope);

    const task: CoderTask = {
      ...(ticket.instruction ? { instruction: ticket.instruction } : {}),
      ticketId,
      key: ticket.key,
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      fileScope: ticket.fileScope,
      notes: ticket.notes ?? [],
    };

    const ctx: AgentContext = {
      runId,
      projectId: payload.projectId ?? "",
      signal: controller.signal,
      emit,
      // The loop charges each turn as it happens, not the running total, so
      // the ceiling is checked against what this run has spent altogether.
      charge: async (usage) => {
        spentCents += usage.costCents;
        spentTokens += budgetTokens(usage);
        if (maxTokens !== undefined && spentTokens >= maxTokens) {
          stop("tokens", new Error(tokenNote(maxTokens, spentTokens)));
        }
        if (billing === "metered" && maxCents !== undefined && spentCents >= maxCents) {
          stop("spend", spendCeiling(maxCents));
        }
      },
      // Nothing here can be asked: this entry has no database to read a stop
      // or a note from, and a person stopping a job stops the job. What a
      // card pulled out from under a run means is the workflow's business.
    };

    const outcome = await runCodingLoop({
      ctx,
      workspace,
      ticketId,
      role: "coder",
      system: jobBrief(task.title),
      prompt: coderPrompt(task),
      // The ticket's budget is the run's ceiling; the loop's turn ceiling is
      // derived from it, so the budget is what stops a run, not a wall of
      // turns reached a fifth of the way in.
      ...(maxDurationMs ? { maxTurns: turnCeiling(maxDurationMs) } : {}),
      provider: payload.provider as ProviderId,
      model: payload.model,
      apiKey: payload.apiKey,
    });

    const changedFiles = await raw.changedFiles().catch(() => []);
    const diff = await raw.diff().catch(() => "");

    if (!outcome.ok) {
      // A turn aborted mid-flight reports the abort, not the reason for it.
      // The reason is ours, and it is what the card has to be able to say.
      const named =
        limit.hit === "time"
          ? timeLimitNote(maxDurationMs, payload.limits?.budgetMs)
          : limit.hit === "tokens"
            ? tokenNote(maxTokens, spentTokens)
            : limit.hit === "spend"
              ? spendNote(maxCents)
              : null;
      return {
        ok: false,
        error: named ?? outcome.error,
        blocked: named ? true : outcome.blocked,
        limit: limit.hit,
        usage: outcome.usage,
        changedFiles,
        diff,
      };
    }

    const { sendBack: _, ...change } = outcome.value;
    return {
      ok: true,
      summary: change.summary,
      detail: change.detail,
      verifiedWith: change.verifiedWith,
      alreadyDone: change.alreadyDone ?? false,
      handoff: change.handoff ?? [],
      limit: null,
      usage: outcome.usage,
      changedFiles,
      diff,
    };
  } finally {
    if (deadline) clearTimeout(deadline);
    await sandbox?.dispose();
  }
}

/**
 * What the job is handed, and what it prints.
 *
 * The payload arrives on stdin, never in argv: argv is visible to anything
 * that can list processes, and the payload carries the person's API key.
 *
 * The options are for a caller that already has a checkout — a test, or a job
 * that passed `actions/checkout` its own — and default to the entry spawning
 * one, which is how the bundle runs.
 */
export async function main(
  input: NodeJS.ReadableStream = process.stdin,
  options: LoopEntryOptions = {},
): Promise<number> {
  try {
    const report = await runLoopEntry(JSON.parse(await readAll(input)), options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.ok ? 0 : 1;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`The loop entry could not run: ${message}\n`);
    // Still JSON, still on stdout: a caller reads one shape whether the run
    // happened or the payload could not be used at all.
    const report: LoopEntryReport = {
      ok: false,
      error: message,
      blocked: false,
      limit: null,
      usage: { model: "unknown", tokensIn: 0, tokensOut: 0, costCents: 0 },
      changedFiles: [],
      diff: "",
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 2;
  }
}

async function readAll(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

function ranOutOfTime(maxDurationMs: number, budgetMs?: number): Error {
  return new Error(timeLimitNote(maxDurationMs, budgetMs));
}

/** Says which ceiling stopped the run: the job's, when it clamped the ticket's budget, or the budget itself. */
function timeLimitNote(maxDurationMs: number | undefined, budgetMs?: number): string {
  const minutes = Math.round((maxDurationMs ?? 0) / 60_000);
  if (budgetMs !== undefined && maxDurationMs !== undefined && budgetMs > maxDurationMs) {
    return `Ran out of time: the job's ceiling stopped it at ${minutes} minutes, and the ticket's budget is ${Math.round(budgetMs / 60_000)}. Do not raise the budget: the job cannot run longer.`;
  }
  return `Ran out of time: this run's budget is ${minutes} minute${minutes === 1 ? "" : "s"}. Raise the ticket's budget to give it longer.`;
}

function tokenNote(maxTokens: number | undefined, usedTokens?: number): string {
  const ceiling = maxTokens === undefined ? "" : `: this run's budget is ${maxTokens.toLocaleString("en-US")} tokens`;
  const spent = usedTokens === undefined ? "" : ` (${usedTokens.toLocaleString("en-US")} spent, input plus output)`;
  return `Token budget reached${ceiling}${spent}. Raise the ticket's token budget under Settings → Limits, or move it to a column with a larger budget; the run can be retried.`;
}

function spendCeiling(maxCents: number): Error {
  return new Error(spendNote(maxCents));
}

function spendNote(maxCents: number | undefined): string {
  return maxCents === undefined
    ? "Spend ceiling reached."
    : `${spendCeilingNote()} Raise the ticket's budget, or move the column to an agent on another account.`;
}

/** One line of progress for a job log, in the voice the board already uses. */
function logLine(event: FormicEvent): string | null {
  switch (event.type) {
    case "run.progress":
      return event.label;
    case "run.thought":
      return event.text.trim() || null;
    case "run.log":
      return event.stream === "stderr" ? `! ${event.line}` : event.line;
    case "run.diff":
      return `Changed ${event.path}`;
    case "ticket.plan":
      return ["Plan:", ...event.steps.map(planLine)].join("\n");
    default:
      return null;
  }
}

function planLine(step: PlanStep): string {
  const mark = step.status === "done" ? "x" : step.status === "in_progress" ? "~" : " ";
  return `- [${mark}] ${step.step}`;
}

/**
 * Run directly, as the bundle is, and not imported by a test: read stdin, run,
 * print, and set the exit code — 0 for a reported change, 1 for a run that
 * failed, 2 for a payload that could not be used.
 *
 * The comparison goes through real paths. Node resolves the module it started
 * to its real path while `argv[1]` keeps the path as it was typed, and on
 * macOS `/tmp` is a symlink to `/private/tmp` — so a plain URL comparison
 * silently finds no match, and the entry does nothing and exits 0, which is
 * the worst way for a job to fail.
 */
function startedHere(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(entry).href === import.meta.url;
  }
}

if (startedHere()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}

