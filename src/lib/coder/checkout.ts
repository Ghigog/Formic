import "server-only";

import { AGENT_COMMIT_AUTHOR, mergeTarget, type VcsClient } from "@/lib/vcs";
import { DEFAULT_TTL_MS, type SandboxHandle } from "@/lib/sandbox/types";
import { spawnSandbox } from "@/lib/sandbox";
import {
  MemoryWorkspace,
  type Workspace,
  sandboxWorkspace,
  scopedWorkspace,
} from "@/lib/sandbox/workspace";
import type { AgentContext } from "@/lib/agents/ports";
import type { TicketDetail } from "@/lib/db/repository";

/**
 * Getting a coding agent a checkout, and getting its work back out again.
 *
 * Shared by PROT-06 and PROT-07 because the two differ only in which branch
 * they start from: the Coder Agent cuts a new one, the Reviewer Agent
 * continues an existing one.
 */

export interface Checkout {
  /** Scoped to the ticket: writes outside its file scope are rejected. */
  workspace: Workspace;
  /** Unscoped, for the pre-commit diff check and for git itself. */
  raw: Workspace;
  sandboxId: string | null;
  dispose(): Promise<void>;
}

export interface CheckoutRequest {
  projectId: string;
  repoFullName: string;
  /** The branch to clone. */
  fromBranch: string;
  /** A new branch to cut from it, or null to work on `fromBranch` directly. */
  newBranch: string | null;
  ticket: TicketDetail;
  ctx: AgentContext;
  /** The project owner's GitHub token. Null runs on an in-memory checkout. */
  githubToken: string | null;
  e2bKey: string | null;
}

type CheckoutFactory = (request: CheckoutRequest) => Promise<Checkout>;

let factory: CheckoutFactory | null = null;

/**
 * Test seam, in the same shape as setAgents and setVcs: it lets a test hold
 * the workspace the pipeline is about to hand an agent, which is the only way
 * to exercise what happens when an agent goes around the scoped workspace.
 */
export function setCheckoutFactory(next: CheckoutFactory | null): void {
  factory = next;
}

export async function openCheckout(
  request: CheckoutRequest,
): Promise<Checkout> {
  if (factory) return factory(request);

  // With no GitHub credential there is nothing to clone and nowhere to push.
  // The board still runs: the agents work against an in-memory checkout and
  // the pull requests are mock ones. See src/lib/vcs/mock.ts.
  if (!request.githubToken) {
    const memory = new MemoryWorkspace();
    return {
      workspace: scopedWorkspace(memory, request.ticket.fileScope),
      raw: memory,
      sandboxId: null,
      async dispose() {},
    };
  }

  const sandbox: SandboxHandle = await spawnSandbox(request.projectId, {
    repoFullName: request.repoFullName,
    // Built here and never stored, so the token cannot end up in a database
    // column or an event payload.
    cloneUrl: `https://x-access-token:${request.githubToken}@github.com/${request.repoFullName}.git`,
    e2bApiKey: request.e2bKey,
    baseBranch: request.fromBranch,
    branchName: request.newBranch ?? undefined,
    ttlMs: DEFAULT_TTL_MS,
    signal: request.ctx.signal,
    onLog: (stream, line) =>
      request.ctx.emit({ type: "run.log", runId: request.ctx.runId, stream, line }),
  });

  const raw = sandboxWorkspace(sandbox);
  return {
    workspace: scopedWorkspace(raw, request.ticket.fileScope),
    raw,
    sandboxId: sandbox.id,
    dispose: () => sandbox.dispose(),
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export type PushOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: string };

/**
 * Commits everything in the checkout and pushes the branch.
 *
 * The author is fixed and recognisable on purpose: PROT-07's fix loop reacts
 * to CI, CI runs on what the fix loop pushed, and the authorship is how that
 * cycle is told apart from a human's push.
 */
export async function commitAndPush(
  checkout: Checkout,
  input: { branch: string; subject: string; body: string },
): Promise<PushOutcome> {
  if (checkout.sandboxId === null) {
    // Mock checkout: nothing to push, and a fabricated sha is honest here
    // because the pull request it lands on is fabricated too.
    return { ok: true, sha: "mock" };
  }

  const { raw } = checkout;
  const message = `${input.subject}\n\n${input.body}\n`;
  const encoded = Buffer.from(message, "utf8").toString("base64");

  const identity = `-c user.name=${quote(AGENT_COMMIT_AUTHOR.name)} -c user.email=${quote(AGENT_COMMIT_AUTHOR.email)}`;
  const commit = await raw.exec(
    `printf '%s' ${quote(encoded)} | base64 -d > .git/FORMIC_COMMITMSG && ` +
      `git add -A && git ${identity} commit -F .git/FORMIC_COMMITMSG`,
  );

  if (commit.exitCode !== 0) {
    return {
      ok: false,
      reason: `Commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`,
    };
  }

  const push = await raw.exec(`git push -u origin ${quote(input.branch)}`, {
    timeoutMs: 3 * 60 * 1000,
  });
  if (push.exitCode !== 0) {
    return {
      ok: false,
      reason: `Push failed: ${push.stderr.trim() || push.stdout.trim()}`,
    };
  }

  const sha = await raw.exec("git rev-parse HEAD");
  return { ok: true, sha: sha.stdout.trim() };
}

/** The pull request body. Links back to the ticket that caused it. */
export function pullRequestBody(
  ticket: TicketDetail,
  change: { summary: string; detail: string; verifiedWith: string | null; handoff?: string[] },
): string {
  return [
    change.detail,
    "",
    // Links the pull request to the ticket's issue on GitHub.
    ...(ticket.issueNumber ? [`Closes #${ticket.issueNumber}.`, ""] : []),
    `## ${ticket.key} — ${ticket.title}`,
    "",
    ticket.description,
    "",
    "### Acceptance criteria",
    "",
    ...ticket.acceptanceCriteria.map((c) => `- ${c}`),
    "",
    "### File scope",
    "",
    ticket.fileScope.map((p) => `\`${p}\``).join(", "),
    "",
    change.verifiedWith
      ? `Verified with \`${change.verifiedWith}\`.`
      : "No verification command was run.",
    "",
    ...(change.handoff?.length
      ? [
          "### For you",
          "",
          "Steps outside the repository no agent can take. The Epic's showcase lists them again once everything has merged.",
          "",
          ...change.handoff.map((s) => `- [ ] ${s}`),
          "",
        ]
      : []),
    "---",
    "",
    "Opened by a Formic Coder Agent.",
  ].join("\n");
}

export async function ensureMergeTarget(
  client: VcsClient,
  target: string,
  baseBranch: string,
): Promise<void> {
  if (target === baseBranch) return;
  await client.ensureBranch(target, baseBranch);
}

/**
 * The branch a new ticket starts from: the one its pull request will merge
 * into, first brought up to date with the base branch. A ticket cut from
 * anywhere else carries the difference between the two into its pull
 * request, and conflicts on it. When the two cannot be merged cleanly no
 * ticket can start safely, and the reason says what a person has to do.
 */
export async function prepareMergeTarget(
  client: VcsClient,
  baseBranch: string,
): Promise<{ ok: true; branch: string } | { ok: false; reason: string }> {
  const target = mergeTarget(baseBranch);
  if (target === baseBranch) return { ok: true, branch: target };
  await client.ensureBranch(target, baseBranch);
  const synced = await client.mergeBranch(target, baseBranch);
  if (synced.ok) return { ok: true, branch: target };
  return {
    ok: false,
    reason: synced.conflict
      ? `${baseBranch} and ${target} have changed the same files and cannot be merged automatically. Merge ${baseBranch} into ${target} on GitHub, resolving the conflicts, then move this ticket to In Progress again.`
      : `Could not bring ${target} up to date with ${baseBranch}: ${synced.reason}`,
  };
}
