import { BoardShell } from "@/components/board/board-shell";
import { hasDatabase, repository } from "@/lib/db";
import { FIXTURE_EXTRAS, FIXTURE_STATS } from "@/lib/fixtures/board";
import { activeProject } from "@/lib/board/project";

export const dynamic = "force-dynamic";

export default async function BoardPage() {
  const repo = repository();
  const project = await activeProject();
  const cards = await repo.boardCards(project.id);
  const provider = process.env.SANDBOX_PROVIDER ?? "local";

  // With no database the default project runs on the demo fixtures, so the
  // ambient bar and the card detail are seeded to match. Anywhere else both
  // start empty and fill from the event stream.
  const demo =
    !hasDatabase() && project.id === (await repo.defaultProject()).id;

  return (
    <BoardShell
      initialCards={cards}
      initialExtras={demo ? FIXTURE_EXTRAS : {}}
      projectName={project.name}
      repoFullName={project.repoFullName}
      baseBranch={project.baseBranch}
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
