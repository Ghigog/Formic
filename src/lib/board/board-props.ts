import "server-only";

import type { ComponentProps } from "react";
import type { BoardShell } from "@/components/board/board-shell";
import { hasDatabase, repository } from "@/lib/db";
import type { ProjectSummary, UserRecord } from "@/lib/db/repository";
import { FIXTURE_EXTRAS, FIXTURE_STATS } from "@/lib/fixtures/board";
import { tokenWindow } from "@/lib/token-window";
import { sentinelsFor } from "@/lib/sentinels/service";
import { credentialsForProject } from "@/lib/auth/credentials";
import { withActor } from "@/lib/auth/actor";
import { agentView } from "@/lib/agents/board-agents";
import { vcs } from "@/lib/vcs";
import { seedReviewCi } from "@/lib/board/review-ci";

/** What the board needs to render a project: BoardShell's props bar the account. */
export type BoardProps = Omit<ComponentProps<typeof BoardShell>, "account">;

/** Loads one board's data for this person: serialisable, so a route can send it. */
export async function boardPropsFor(project: ProjectSummary, user: UserRecord): Promise<BoardProps> {
  const repo = repository();
  const window = tokenWindow(
    {
      renewalDay: user.tokenRenewalDay,
      timezone: user.tokenWindowTimezone,
      resetAt: user.tokenResetAt,
    },
    new Date(),
  );
  const provider = process.env.SANDBOX_PROVIDER ?? "local";
  // The viewer's own keys: on a shared board, theirs are what their runs use.
  const credentials = withActor(user.id, () => credentialsForProject(project)).catch(() => null);
  const [cards, { presets, columns: columnAgents }, columnOverrides, sentinels, agentUsage, hasCi, noSandboxKey] = await Promise.all([
    repo.boardCards(project.id),
    agentView(project, user),
    repo.columnOverrides(project.id),
    sentinelsFor(project.id),
    // What each agent has used, in tokens: counted per agent since the
    // person's token window began, from the runs and answers that agent did (see docs/token-usage.md).
    repo.agentTokensByPreset(window.since),
    // Whether review cards have checks to wait for. Unknown reads as yes,
    // so the card says CI is running, as it did before it could tell.
    credentials
      .then((creds) => (creds && project.repoFullName ? vcs(project.repoFullName, creds.githubToken).hasCi(project.baseBranch) : true))
      .catch(() => true),
    // No agent can run without a sandbox, so the board says so before
    // anyone starts a ticket rather than when the first one fails.
    credentials.then((creds) => provider === "e2b" && !!creds && !creds.e2bKey),
  ]);

  // With no database the default project runs on the demo fixtures, so the
  // ambient bar and the card detail are seeded to match. Anywhere else both
  // start empty and fill from the event stream.
  const demo =
    !hasDatabase() && project.id === (await repo.defaultProject()).id;

  // Review cards start from what GitHub says about their checks, not from the
  // live events a reload has missed. No credentials or a failed lookup leaves
  // them unknown.
  const reviewCi = demo || !project.repoFullName
    ? {}
    : await credentials
        .then((creds) => (creds ? seedReviewCi(vcs(project.repoFullName, creds.githubToken), cards) : {}))
        .catch(() => ({}));

  return {
    initialCards: cards,
    initialExtras: demo ? FIXTURE_EXTRAS : reviewCi,
    projectName: project.name,
    repoFullName: project.repoFullName,
    noCi: !hasCi,
    noSandboxKey,
    autoMerge: project.autoMerge,
    baseBranch: project.baseBranch,
    initialPresets: presets,
    initialColumnAgents: columnAgents,
    initialOverrides: columnOverrides,
    initialAgentUsage: agentUsage,
    initialTokenWindow: {
      kind: window.kind,
      since: window.since?.toISOString() ?? null,
      timezone: user.tokenWindowTimezone,
    },
    initialSentinels: sentinels,
    initialStats: demo
      ? { ...FIXTURE_STATS, provider }
      : {
          activeSandboxes: 0,
          provider,
          tokensIn: 0,
          tokensOut: 0,
          costCents: 0,
          logLines: [],
        },
  };
}
