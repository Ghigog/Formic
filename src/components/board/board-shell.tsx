"use client";

import { useState } from "react";
import { Board } from "./board";
import { NewItemDialog } from "./new-item-dialog";
import { AmbientDrawer, type AmbientStats } from "@/components/ui/ambient-drawer";
import type { BoardCard } from "@/lib/domain/entities";
import { useBoard } from "@/lib/hooks/use-board";

/**
 * Client shell: owns the live board state, the capture dialog and the ambient
 * bar. Everything it renders is driven by the server plus the event stream.
 */
export function BoardShell({
  initialCards,
  projectName,
  repoFullName,
  baseBranch,
  initialStats,
}: {
  initialCards: BoardCard[];
  projectName: string;
  repoFullName: string;
  baseBranch: string;
  initialStats: AmbientStats;
}) {
  const { cards, extras, stats, connection, transition, createEpic } = useBoard(
    initialCards,
    initialStats,
  );
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <Board
        cards={cards}
        extras={extras}
        projectName={projectName}
        repoFullName={repoFullName}
        baseBranch={baseBranch}
        onOpenCard={() => {}}
        onNewItem={() => setDialogOpen(true)}
        onTransition={transition}
      />

      <NewItemDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={createEpic}
      />

      <AmbientDrawer stats={stats} />

      {connection === "reconnecting" && (
        <div
          role="status"
          className="border-rust bg-rust/10 text-rust-text fixed bottom-12 left-2 z-40 rounded border px-2 py-1 text-[11px]"
        >
          Reconnecting to the agent stream…
        </div>
      )}
    </>
  );
}
