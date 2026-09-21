import { BoardShell } from "@/components/board/board-shell";
import { repository } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function BoardPage() {
  const repo = repository();
  const project = await repo.defaultProject();
  const cards = await repo.boardCards(project.id);

  return (
    <BoardShell
      initialCards={cards}
      projectName={project.name}
      repoFullName={project.repoFullName}
      baseBranch={project.baseBranch}
      initialStats={{
        activeSandboxes: 0,
        provider: process.env.SANDBOX_PROVIDER ?? "local",
        tokensIn: 0,
        tokensOut: 0,
        costCents: 0,
        logLines: [],
      }}
    />
  );
}
