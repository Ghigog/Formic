import { BoardShell } from "@/components/board/board-shell";
import type { CardExtras } from "@/components/board/card";
import {
  FIXTURE_CARDS,
  FIXTURE_CI,
  FIXTURE_PROGRESS,
} from "@/lib/fixtures/board";

export default function BoardPage() {
  const extras: Record<string, CardExtras | undefined> = {};
  for (const [id, ci] of Object.entries(FIXTURE_CI)) {
    extras[id] = { ...extras[id], ci };
  }
  for (const [id, progress] of Object.entries(FIXTURE_PROGRESS)) {
    extras[id] = { ...extras[id], progress };
  }

  return (
    <BoardShell
      initialCards={FIXTURE_CARDS}
      extras={extras}
      projectName="Formic"
      repoFullName={process.env.GITHUB_REPO ?? "Ghigog/Formic"}
      baseBranch={process.env.GITHUB_BASE_BRANCH ?? "main"}
      stats={{
        activeSandboxes: 0,
        provider: process.env.SANDBOX_PROVIDER ?? "local",
        tokensIn: 128_400,
        tokensOut: 31_200,
        costCents: 212,
        logLines: [],
      }}
    />
  );
}
