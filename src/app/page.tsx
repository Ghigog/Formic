import { redirect } from "next/navigation";
import { BoardShell } from "@/components/board/board-shell";
import { Welcome } from "@/components/board/welcome";
import { hasDatabase, repository } from "@/lib/db";
import { FIXTURE_EXTRAS, FIXTURE_STATS } from "@/lib/fixtures/board";
import { activeProject } from "@/lib/board/project";
import { currentUser, ownerScope } from "@/lib/auth/user";
import { tokenWindow } from "@/lib/token-window";
import { authMode } from "@/lib/auth/session";
import { sentinelsFor } from "@/lib/sentinels/service";
import type { Account } from "@/components/board/account-menu";

export const dynamic = "force-dynamic";

export default async function BoardPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  const account: Account = {
    login: user.login,
    name: user.name,
    avatarUrl: user.avatarUrl,
    signedIn: authMode() === "github",
  };

  const repo = repository();
  const project = await activeProject();
  if (!project) return <Welcome account={account} />;

  const window = tokenWindow(
    {
      renewalDay: user.tokenRenewalDay,
      timezone: user.tokenWindowTimezone,
      resetAt: user.tokenResetAt,
    },
    new Date(),
  );
  const [cards, presets, columnAgents, columnOverrides, sentinels, agentUsage] = await Promise.all([
    repo.boardCards(project.id),
    repo.listPresets(ownerScope(user)),
    repo.columnAgents(project.id),
    repo.columnOverrides(project.id),
    sentinelsFor(project.id),
    // What each agent has used, in tokens: counted per agent since the
    // person's token window began, from the runs and answers that agent did (see docs/token-usage.md).
    repo.agentTokensByPreset(window.since),
  ]);
  const provider = process.env.SANDBOX_PROVIDER ?? "local";

  // With no database the default project runs on the demo fixtures, so the
  // ambient bar and the card detail are seeded to match. Anywhere else both
  // start empty and fill from the event stream.
  const demo =
    !hasDatabase() && project.id === (await repo.defaultProject()).id;

  return (
    <BoardShell
      account={account}
      initialCards={cards}
      initialExtras={demo ? FIXTURE_EXTRAS : {}}
      projectName={project.name}
      repoFullName={project.repoFullName}
      baseBranch={project.baseBranch}
      initialPresets={presets}
      initialColumnAgents={columnAgents}
      initialOverrides={columnOverrides}
      initialAgentUsage={agentUsage}
      initialTokenWindow={{
        kind: window.kind,
        since: window.since?.toISOString() ?? null,
        timezone: user.tokenWindowTimezone,
      }}
      initialSentinels={sentinels}
      initialStats={
        demo
          ? { ...FIXTURE_STATS, provider }
          : {
              activeSandboxes: 0,
              provider,
              tokensIn: 0,
              tokensOut: 0,
              costCents: 0,
              logLines: [],
            }
      }
    />
  );
}
